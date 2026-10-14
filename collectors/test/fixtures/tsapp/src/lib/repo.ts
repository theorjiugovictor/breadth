import { Pool } from "pg";

const pool = new Pool();

export class Repo {
  constructor(private table: string) {}

  async find(id: string): Promise<unknown> {
    const r = await pool.query(`SELECT * FROM ${this.table} WHERE id=$1`, [id]);
    return this.map(r.rows[0]);
  }

  map(row: unknown) {
    return row;
  }
}
