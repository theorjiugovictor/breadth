import express from "express";
import axios from "axios";
import { add, double, tick, Repository } from "./lib";

const app = express();

export async function handler(req: { id: string }): Promise<number> {
  const repo = new Repository("users");
  await repo.find(req.id);
  [1, 2, 3].map((n) => double(n));
  if (req.id) tick();
  await axios.post("https://api.stripe.com/v1/charges", {});
  await fetch(`${process.env.PAYMENTS_URL}/pay`);
  return add(1, 2);
}

app.get("/x", handler);
