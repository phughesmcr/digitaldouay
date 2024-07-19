#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run

/**
 * @module      PDF2PNG
 * @description Convert a PDF to PNG images of individual pages
 * @author      P. Hughes <code@phugh.es> (https://phugh.es)
 * @copyright   2024. All rights reserved.
 * @license     MIT
 *
 * @requires    imagemagick (https://imagemagick.org)
 * @requires    ghostscript (https://ghostscript.com) on Windows
 *
 * @arguments   {string} input - The path to the PDF file to process.
 *              {number} [start=0] - The page number to start processing from. 0-indexed.
 *              {number} [end] - The page number to stop processing at. 0-indexed.
 *              {number} [dpi=300] - The resolution to render the PDF at.
 */

import { getDocument } from "npm:pdfjs-dist";

type MetaData = { userStartPage: number; userEndPage: number; chunkSize: number };

const USAGE = "Usage: deno run -A pdf2png.ts <input.pdf> [start] [end] [dpi]" as const;

const performMagick = async (input: string, start: number, end: number, density = 300): Promise<number> => {
  const command = new Deno.Command("magick", {
    args: [
      "-define",
      `registry:temporary-path='${Deno.cwd()}'`,
      "-density",
      density.toString(),
      `${input}[${start}-${end}]`,
      `PNG:${input}.png`,
    ],
    stderr: "piped",
  });
  const { code, stderr } = await command.output();
  if (code !== 0) throw new Error(new TextDecoder().decode(stderr));
  return code;
};

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(Math.max(value, min), max);
};

const isInvalidPage = (n: number): boolean => {
  return isNaN(n) || n < 0 || !Number.isInteger(n) || !isFinite(n);
};

const getTotalPages = async (input: string): Promise<number> => {
  const doc = await getDocument(input).promise;
  return doc.numPages;
};

const getMeta = async (path: string): Promise<MetaData> => {
  const totalPages = await getTotalPages(path);
  const userStartPage = Deno.args[1] ? parseInt(Deno.args[1], 10) - 1 : 0;
  const userEndPage = Deno.args[2] ? parseInt(Deno.args[2], 10) - 1 : totalPages;
  const userPages = userEndPage - userStartPage;
  if ([userStartPage, userEndPage, userPages].some(isInvalidPage)) {
    throw new RangeError("Invalid page range provided.");
  }
  const chunkSize = clamp(Math.floor((userPages + 1) / 20), 5, 25);
  console.log(`...${userPages} pages (${userStartPage + 1} to ${userEndPage + 1})...`);
  return { userStartPage, userEndPage, chunkSize };
};

const parseInputPath = async (): Promise<string> => {
  const path = Deno.args[0].trim();
  if (!path) throw new SyntaxError(`No input provided. ${USAGE}`);
  if (!path.endsWith(".pdf")) throw new TypeError("Input must be a PDF file.");
  if (!(await Deno.stat(path)).isFile) throw new Error(`Input file not found: ${path}`);
  return path;
};

async function main(path: string): Promise<void> {
  const { userStartPage, userEndPage, chunkSize } = await getMeta(path);
  for (let page = userStartPage; page < userEndPage + chunkSize; page += chunkSize) {
    if (page >= userEndPage) break;
    const end = Math.min(page + chunkSize - 1, userEndPage);
    const cent = Math.min((end / userEndPage) * 100, 100);
    console.log(`[${cent.toFixed(2)}%] Processing pages ${page + 1} to ${end + 1}...`);
    await performMagick(path, page, end);
  }
}

if (import.meta.main) {
  try {
    const path = await parseInputPath();
    console.log(`Processing ${path}...`);
    await main(path);
    console.log("Done!");
    Deno.exit(0);
  } catch (err) {
    console.error(err);
    alert();
    Deno.exit(1);
  }
}
