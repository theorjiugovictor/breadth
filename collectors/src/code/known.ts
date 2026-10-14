import type { Lang } from "./model.js";

/** What an external package is, so calls into it can become richer nodes than "a library". */
export type PackageClass =
  | { type: "stdlib" }
  | { type: "lib" }
  | { type: "http" }
  | { type: "db"; engine: string }
  | { type: "queue"; system: string };

const PY_STDLIB = new Set(
  `abc argparse array ast asyncio atexit base64 binascii bisect builtins bz2 calendar cmath codecs collections
  colorsys concurrent configparser contextlib contextvars copy csv ctypes dataclasses datetime decimal difflib dis
  email enum errno faulthandler fcntl filecmp fileinput fnmatch fractions functools gc getopt getpass gettext glob
  gzip hashlib heapq hmac html http imaplib importlib inspect io ipaddress itertools json keyword linecache locale
  logging lzma mailbox math mimetypes mmap multiprocessing netrc numbers operator optparse os pathlib pickle pkgutil
  platform plistlib pprint profile pstats queue quopri random re readline reprlib resource sched secrets select
  selectors shelve shlex shutil signal site smtplib socket socketserver ssl stat statistics string stringprep struct
  subprocess sys sysconfig tarfile tempfile textwrap threading time timeit token tokenize tomllib trace traceback
  tracemalloc types typing typing_extensions unicodedata unittest urllib uuid venv warnings wave weakref xml zipfile
  zipimport zlib zoneinfo __future__`.split(/\s+/),
);

const NODE_BUILTINS = new Set(
  `assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain
  events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl
  stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib test`.split(/\s+/),
);

const HTTP_PKGS = new Set(["requests", "httpx", "aiohttp", "urllib3", "axios", "node-fetch", "got", "undici", "ky", "superagent", "cross-fetch", "isomorphic-fetch"]);

const DB_PKGS: Record<string, string> = {
  psycopg: "postgresql",
  psycopg2: "postgresql",
  asyncpg: "postgresql",
  pg: "postgresql",
  postgres: "postgresql",
  pymysql: "mysql",
  mysqlclient: "mysql",
  MySQLdb: "mysql",
  mysql: "mysql",
  mysql2: "mysql",
  sqlite3: "sqlite",
  "better-sqlite3": "sqlite",
  aiosqlite: "sqlite",
  pymongo: "mongodb",
  motor: "mongodb",
  mongodb: "mongodb",
  mongoose: "mongodb",
  redis: "redis",
  aioredis: "redis",
  ioredis: "redis",
  sqlalchemy: "sql",
  sqlmodel: "sql",
  peewee: "sql",
  knex: "sql",
  typeorm: "sql",
  sequelize: "sql",
  "drizzle-orm": "sql",
  "@prisma/client": "sql",
  "@supabase/supabase-js": "postgresql",
  elasticsearch: "elasticsearch",
  "@elastic/elasticsearch": "elasticsearch",
  boto3: "aws",
  "@aws-sdk/client-dynamodb": "dynamodb",
  "@aws-sdk/client-s3": "s3",
};

const QUEUE_PKGS: Record<string, string> = {
  kafka: "kafka",
  confluent_kafka: "kafka",
  aiokafka: "kafka",
  kafkajs: "kafka",
  "@confluentinc/kafka-javascript": "kafka",
  pika: "rabbitmq",
  aio_pika: "rabbitmq",
  amqplib: "rabbitmq",
  "amqp-connection-manager": "rabbitmq",
  nats: "nats",
  "nats.py": "nats",
  bullmq: "bullmq",
  bull: "bullmq",
  celery: "celery",
  "@aws-sdk/client-sqs": "sqs",
  "@aws-sdk/client-sns": "sns",
  "@google-cloud/pubsub": "pubsub",
};

export function packageName(spec: string, lang: Lang): string {
  if (lang === "python") return spec.split(".")[0];
  if (spec.startsWith("node:")) return spec;
  if (spec.startsWith("@")) return spec.split("/").slice(0, 2).join("/");
  return spec.split("/")[0];
}

export function classifyPackage(pkg: string, lang: Lang): PackageClass {
  if (lang === "python" ? PY_STDLIB.has(pkg) && pkg !== "sqlite3" : pkg.startsWith("node:") || NODE_BUILTINS.has(pkg)) {
    return { type: "stdlib" };
  }
  if (HTTP_PKGS.has(pkg)) return { type: "http" };
  if (pkg in DB_PKGS) return { type: "db", engine: DB_PKGS[pkg] };
  if (pkg in QUEUE_PKGS) return { type: "queue", system: QUEUE_PKGS[pkg] };
  return { type: "lib" };
}

export const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "request", "fetch"]);

const READ_METHODS = /^(execute|executemany|query|fetch\w*|select|find\w*|get\w*|h?mget|hgetall|smembers|lrange|zrange\w*|exists|count\w*|aggregate|scan|search|load|read\w*|list\w*|first|all|one|raw)$/i;
const WRITE_METHODS = /^(insert\w*|update\w*|upsert\w*|delete\w*|remove\w*|replace\w*|save|create\w*|put\w*|set\w*|h?mset|hset|sadd|srem|[lr]push|zadd|incr\w*|decr\w*|expire\w*|commit|bulk_?write|write\w*|add|merge|flush|truncate|drop\w*)$/i;

/** Decide if a call into a datastore client reads or writes, from the method name and SQL text. */
export function dbAccessMode(method: string, firstArg?: string): "read" | "write" | undefined {
  if (firstArg) {
    const sql = firstArg.trim().toUpperCase();
    if (/^(SELECT|WITH|SHOW|DESCRIBE|EXPLAIN)\b/.test(sql)) return "read";
    if (/^(INSERT|UPDATE|DELETE|UPSERT|MERGE|CREATE|ALTER|DROP|TRUNCATE|REPLACE)\b/.test(sql)) return "write";
  }
  if (READ_METHODS.test(method)) return "read";
  if (WRITE_METHODS.test(method)) return "write";
  return undefined;
}

export function sqlLabel(sql?: string): string | undefined {
  if (!sql) return undefined;
  const s = sql.replace(/\s+/g, " ").trim();
  const verb = s.split(" ")[0]?.toUpperCase();
  if (!verb || !/^(SELECT|INSERT|UPDATE|DELETE|UPSERT|WITH|MERGE|CREATE|REPLACE)$/.test(verb)) return undefined;
  const table = s.match(/\b(?:FROM|INTO|UPDATE|JOIN)\s+["`]?([\w.]+)/i)?.[1];
  return table ? `${verb} ${table}` : verb;
}

export const PRODUCE_METHODS = /^(send\w*|produce\w*|publish\w*|basic_publish|emit|add|enqueue|delay|apply_async)$/;
export const CONSUME_METHODS = /^(subscribe|consume|poll|basic_consume|on_message|KafkaConsumer|Consumer|AIOKafkaConsumer|Worker)$/;
