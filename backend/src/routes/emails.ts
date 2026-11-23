import { Router } from "express";
import { z } from "zod";
import { db, fields, join } from "../db/database";
import { elastic } from "../services/search";
import { ensureEmailIndex } from "../services/search";
const router = Router();
router.get("/", async (req, res) => {
  const filters = z
    .object({
      tab: z.enum(["scheduled", "sent"]).default("scheduled"),
      q: z.string().trim().max(250).default(""),
      page: z.coerce.number().int().min(1).max(400).default(1),
    })
    .parse(req.query);
  const statuses =
    filters.tab === "scheduled"
      ? ["scheduled", "sending"]
      : ["sent", "failed", "uncertain"];
  const offset = (filters.page - 1) * 25,
    owner = req.user!.id;
  let rows;
  if (filters.q) {
    await ensureEmailIndex();
    const result = await elastic("/emails/_search", "POST", {
      from: offset,
      size: 25,
      query: {
        bool: {
          filter: [{ term: { owner } }, { terms: { status: statuses } }],
          must: [
            {
              multi_match: {
                query: filters.q,
                fields: ["recipient", "subject", "body"],
                type: "bool_prefix",
              },
            },
          ],
        },
      },
      sort: [
        {
          [filters.tab === "scheduled" ? "due" : "finished"]:
            filters.tab === "scheduled" ? "asc" : "desc",
        },
        { id: "asc" },
      ],
    });
    const ids = result.hits.hits.map((h: { _id: string }) => h._id);
    rows = (
      await db.query(
        "SELECT " +
          fields +
          join +
          "WHERE c.owner=$1 AND e.status=ANY($2) AND e.id=ANY($3::uuid[]) ORDER BY array_position($3::uuid[],e.id)",
        [owner, statuses, ids],
      )
    ).rows;
  } else {
    rows = (
      await db.query(
        "SELECT " +
          fields +
          join +
          "WHERE c.owner=$1 AND e.status=ANY($2) ORDER BY " +
          (filters.tab === "scheduled" ? "e.due ASC" : "e.finished DESC") +
          ",e.id LIMIT 25 OFFSET $3",
        [owner, statuses, offset],
      )
    ).rows;
  }
  res.json({ rows });
});
export default router;
