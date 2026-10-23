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

/** Go and Java libraries, by import-path prefix. */
const PREFIX_CLASSES: [Lang, string, PackageClass][] = [
  // Go
  ["go", "net/http", { type: "http" }],
  ["go", "github.com/go-resty/resty", { type: "http" }],
  ["go", "database/sql", { type: "db", engine: "sql" }],
  ["go", "github.com/jmoiron/sqlx", { type: "db", engine: "sql" }],
  ["go", "gorm.io", { type: "db", engine: "sql" }],
  ["go", "github.com/jackc/pgx", { type: "db", engine: "postgresql" }],
  ["go", "github.com/lib/pq", { type: "db", engine: "postgresql" }],
  ["go", "github.com/go-sql-driver/mysql", { type: "db", engine: "mysql" }],
  ["go", "go.mongodb.org/mongo-driver", { type: "db", engine: "mongodb" }],
  ["go", "github.com/redis/go-redis", { type: "db", engine: "redis" }],
  ["go", "github.com/go-redis/redis", { type: "db", engine: "redis" }],
  ["go", "github.com/aws/aws-sdk-go", { type: "db", engine: "aws" }],
  ["go", "github.com/segmentio/kafka-go", { type: "queue", system: "kafka" }],
  ["go", "github.com/IBM/sarama", { type: "queue", system: "kafka" }],
  ["go", "github.com/Shopify/sarama", { type: "queue", system: "kafka" }],
  ["go", "github.com/confluentinc/confluent-kafka-go", { type: "queue", system: "kafka" }],
  ["go", "github.com/rabbitmq/amqp091-go", { type: "queue", system: "rabbitmq" }],
  ["go", "github.com/streadway/amqp", { type: "queue", system: "rabbitmq" }],
  ["go", "github.com/nats-io/nats.go", { type: "queue", system: "nats" }],
  ["go", "cloud.google.com/go/pubsub", { type: "queue", system: "pubsub" }],
  // Java
  ["java", "java.net.http", { type: "http" }],
  ["java", "org.springframework.web.client", { type: "http" }],
  ["java", "org.springframework.web.reactive.function.client", { type: "http" }],
  ["java", "okhttp3", { type: "http" }],
  ["java", "org.apache.http", { type: "http" }],
  ["java", "feign", { type: "http" }],
  ["java", "java.sql", { type: "db", engine: "sql" }],
  ["java", "javax.sql", { type: "db", engine: "sql" }],
  ["java", "org.springframework.jdbc", { type: "db", engine: "sql" }],
  ["java", "org.springframework.data.jpa", { type: "db", engine: "sql" }],
  ["java", "org.springframework.data.repository", { type: "db", engine: "sql" }],
  ["java", "jakarta.persistence", { type: "db", engine: "sql" }],
  ["java", "javax.persistence", { type: "db", engine: "sql" }],
  ["java", "org.hibernate", { type: "db", engine: "sql" }],
  ["java", "org.jooq", { type: "db", engine: "sql" }],
  ["java", "org.springframework.data.mongodb", { type: "db", engine: "mongodb" }],
  ["java", "com.mongodb", { type: "db", engine: "mongodb" }],
  ["java", "org.springframework.data.redis", { type: "db", engine: "redis" }],
  ["java", "redis.clients.jedis", { type: "db", engine: "redis" }],
  ["java", "io.lettuce", { type: "db", engine: "redis" }],
  ["java", "software.amazon.awssdk", { type: "db", engine: "aws" }],
  ["java", "org.springframework.kafka", { type: "queue", system: "kafka" }],
  ["java", "org.apache.kafka", { type: "queue", system: "kafka" }],
  ["java", "org.springframework.amqp", { type: "queue", system: "rabbitmq" }],
  ["java", "com.rabbitmq", { type: "queue", system: "rabbitmq" }],
  ["java", "io.nats", { type: "queue", system: "nats" }],
  ["java", "org.springframework.jms", { type: "queue", system: "jms" }],
  ["java", "jakarta.jms", { type: "queue", system: "jms" }],
];

export function packageName(spec: string, lang: Lang): string {
  if (lang === "python") return spec.split(".")[0];
  // Go: the module (github.com/org/repo), or the full path for the standard library
  if (lang === "go") return spec.split("/")[0].includes(".") ? spec.split("/").slice(0, 3).join("/") : spec;
  // Java: a known library prefix, else the first three name parts (org.springframework.kafka)
  if (lang === "java") return PREFIX_CLASSES.find(([l, p]) => l === "java" && (spec === p || spec.startsWith(`${p}.`)))?.[1] ?? spec.split(".").slice(0, 3).join(".");
  if (spec.startsWith("node:")) return spec;
  if (spec.startsWith("@")) return spec.split("/").slice(0, 2).join("/");
  return spec.split("/")[0];
}

export function classifyPackage(pkg: string, lang: Lang): PackageClass {
  if (lang === "go" || lang === "java") {
    const sep = lang === "go" ? "/" : ".";
    // github.com/aws/aws-sdk-go-v2 is the aws-sdk-go family; github.com/redis/go-redis/v9 is go-redis
    const hit = PREFIX_CLASSES.find(([l, p]) => l === lang && (pkg === p || pkg.startsWith(`${p}${sep}`) || p.startsWith(`${pkg}${sep}`) || (lang === "go" && pkg.startsWith(`${p}-`))));
    if (hit) return hit[2];
    if (lang === "go" ? !pkg.split("/")[0].includes(".") : /^(java|javax|jdk|sun)\./.test(pkg)) return { type: "stdlib" };
    return { type: "lib" };
  }
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

// Case-insensitive: Go and C#-style SDKs capitalise (WriteMessages, Publish, Subscribe).
export const PRODUCE_METHODS = /^(send\w*|produce\w*|publish\w*|basic_publish|emit|add|enqueue|delay|apply_async|writeMessages?|convertAndSend)$/i;
export const CONSUME_METHODS = /^(subscribe|consume|poll|basic_consume|on_message|KafkaConsumer|Consumer|AIOKafkaConsumer|Worker|readMessage|fetchMessage|chanSubscribe|queueSubscribe|receive)$/i;
