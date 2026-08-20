import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/**
 * CEG's own knowledge, loaded from disk and injected as a system block.
 *
 * The files live OUTSIDE this repository on purpose. They carry every
 * teammate's email, personal addresses, roles and who may approve money, and
 * this repo is public — so the code ships here and the knowledge is deployed to
 * the VPS separately. CEG_KNOWLEDGE_DIR points at it; nothing is bundled.
 *
 * Loaded once at boot and held in memory: it is a few thousand tokens that
 * change monthly, so re-reading per request would buy nothing.
 */

export interface Knowledge {
  text: string;
  files: string[];
  bytes: number;
  loadedAt: string | null;
}

let cache: Knowledge = { text: "", files: [], bytes: 0, loadedAt: null };

export const loaded = () => cache.bytes > 0;
export const info = () => ({ files: cache.files, bytes: cache.bytes, loadedAt: cache.loadedAt });

/** Read every .md in the knowledge directory, newest ordering by filename. */
export function load(): Knowledge {
  const dir = config.knowledge.dir;
  if (!dir) {
    cache = { text: "", files: [], bytes: 0, loadedAt: null };
    return cache;
  }

  let names: string[];
  try {
    names = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .sort();
  } catch (e: any) {
    console.warn(`[ceg-brain] knowledge dir unreadable (${dir}): ${e.message}`);
    cache = { text: "", files: [], bytes: 0, loadedAt: null };
    return cache;
  }

  const parts: string[] = [];
  const files: string[] = [];
  let bytes = 0;

  for (const name of names) {
    if (bytes >= config.knowledge.maxBytes) {
      console.warn(`[ceg-brain] knowledge cap reached; skipping ${name} and later files`);
      break;
    }
    try {
      const body = fs.readFileSync(path.join(dir, name), "utf8").trim();
      if (!body) continue;
      // Name each document so the model can attribute a fact to its source.
      parts.push(`### ${name}\n\n${body}`);
      files.push(name);
      bytes += body.length;
    } catch (e: any) {
      console.warn(`[ceg-brain] could not read ${name}: ${e.message}`);
    }
  }

  cache = {
    text: parts.join("\n\n---\n\n"),
    files,
    bytes,
    loadedAt: parts.length ? new Date().toISOString() : null,
  };
  return cache;
}

/** The system block handed to Claude on the CEG endpoint. */
export function systemBlock(): string {
  return `You are CEG Group's internal assistant. The documents below are CEG's own knowledge base — its people, business units, products, operating protocols and platform architecture. Treat them as authoritative and current.

HOW TO USE THEM:
- Prefer these documents over anything you remember about CEG Group. If they contradict your training, they are right.
- Use the real names, aliases and spellings given here. "CG" in a transcript means CEG.
- Where a document states who owns or decides something, follow it — do not reassign.
- If the answer is not in these documents, say so plainly instead of inventing it. These cover the company, not the day-to-day: for what happened this week, the caller has to supply it.
- Never repeat someone's email address unless the user asked for it specifically.

=== CEG KNOWLEDGE BASE ===

${cache.text}

=== END KNOWLEDGE BASE ===`;
}
