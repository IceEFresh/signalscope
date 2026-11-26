/**
 * P3-0n: disk caches for the Form 4 and FINRA raw files, shared by the backfill scripts and the
 * live harvest (scripts/output/edgar-form4/ and scripts/output/finra/, bind-mounted into the
 * harvester). Raw text is gzipped. Filed documents never change, so nothing expires except the
 * issuer's main submissions JSON, which the caller refetches when it wants new filings.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Form4Cache } from "./form4-history";
import type { FinraCache } from "./finra";

export const FORM4_CACHE_DIR = process.env.FORM4_CACHE_DIR || "scripts/output/edgar-form4";
export const FINRA_CACHE_DIR = process.env.FINRA_CACHE_DIR || "scripts/output/finra";
export const FLOATS_FILE = "floats.json";

const readGz = (path: string): string | null => (existsSync(path) ? gunzipSync(readFileSync(path)).toString("utf8") : null);
const writeGz = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, gzipSync(text));
};

export function fsForm4Cache(dir = FORM4_CACHE_DIR): Form4Cache {
  // XMLs bucketed by the accession's last two digits, so no folder holds tens of thousands of files
  const xmlPath = (accession: string) => join(dir, "xml", accession.slice(-2), `${accession}.xml.gz`);
  const jsonPath = (name: string) => join(dir, "submissions", `${name}.gz`);
  return {
    readJson: (name) => {
      const t = readGz(jsonPath(name));
      return t == null ? null : (JSON.parse(t) as unknown);
    },
    writeJson: (name, json) => writeGz(jsonPath(name), JSON.stringify(json)),
    readXml: (accession) => readGz(xmlPath(accession)),
    writeXml: (accession, xml) => writeGz(xmlPath(accession), xml),
  };
}

export function fsFinraCache(dir = FINRA_CACHE_DIR): FinraCache {
  const path = (name: string) => join(dir, "raw", `${name}.gz`);
  return { read: (name) => readGz(path(name)), write: (name, text) => writeGz(path(name), text) };
}

export interface FloatsFile {
  fetchedAt: string;
  /** Yahoo floatShares by symbol; null = Yahoo had none. */
  floats: Record<string, number | null>;
}

export function readFloats(dir = FINRA_CACHE_DIR): FloatsFile | null {
  const p = join(dir, FLOATS_FILE);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as FloatsFile;
    return j && typeof j.floats === "object" ? j : null;
  } catch {
    return null;
  }
}

export function writeFloats(file: FloatsFile, dir = FINRA_CACHE_DIR): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FLOATS_FILE), JSON.stringify(file));
}

export const HOUSE_CACHE_DIR = process.env.HOUSE_CACHE_DIR || "scripts/output/house-ptr";

/** P3-0p: House Clerk index ZIPs, PTR PDFs and parses (PDFs and ZIPs as is; JSON plain). */
export function fsHouseCache(dir = HOUSE_CACHE_DIR): import("./house-ptr").HouseCache {
  const p = (name: string) => join(dir, name);
  return {
    readBytes: (name) => (existsSync(p(name)) ? new Uint8Array(readFileSync(p(name))) : null),
    writeBytes: (name, data) => {
      mkdirSync(dirname(p(name)), { recursive: true });
      writeFileSync(p(name), data);
    },
    readJson: (name) => (existsSync(p(name)) ? (JSON.parse(readFileSync(p(name), "utf8")) as unknown) : null),
    writeJson: (name, json) => {
      mkdirSync(dirname(p(name)), { recursive: true });
      writeFileSync(p(name), JSON.stringify(json));
    },
  };
}
