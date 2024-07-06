#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run

/**
 * @module      PDF2IMG_CLAUDE
 * @description Convert a PDF to images of individual pages sized for Claude 3 & 3.5
 * @author      P. Hughes <code@phugh.es> (https://phugh.es)
 * @copyright   2024. All rights reserved.
 * @license     MIT
 *
 * @requires    imagemagick (https://imagemagick.org)
 * @requires    ghostscript (https://ghostscript.com)
 *
 * @arguments   {string} input - The path to the PDF file to process.
 *              {number} [start=0] - The page number to start processing from. 0-indexed.
 *              {number} [end] - The page number to stop processing at. 0-indexed.
 */

import { getDocument } from "npm:pdfjs-dist";

const performMagick = async (input: string, start: number, end: number) => {
  const command = new Deno.Command("magick", {
    args: [
      "-define", `registry:temporary-path='${Deno.cwd()}'`,
      "-density", "300",
      "-quality", "100",
      `${input}[${start}-${end}]`,
      "-filter", "Lanczos",
      "-resize", "1568",
      `JPEG:${input}.jpg`,
    ],
    stderr: "piped",
  });
  const { code, stderr } = await command.output();
  if (code !== 0) throw new Error(new TextDecoder().decode(stderr));
  return code;
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const getTotalPages = async (input: string): Promise<number> => {
  const doc = await getDocument(input).promise;
  return doc.numPages;
};

const getInputFileData = async (input: string) => {
  const totalPages = await getTotalPages(input);
  const userStartPage = Deno.args[1] ? parseInt(Deno.args[1], 10) - 1 : 0;
  const userEndPage = Deno.args[2] ? parseInt(Deno.args[2], 10) - 1 : totalPages;
  const userPages = userEndPage - userStartPage;
  if ([userStartPage, userEndPage, userPages].some(isInvalidPage)) {
    throw new RangeError("Invalid page range provided.");
  }
  return { totalPages, userStartPage, userEndPage, userPages } as const;
};

const isInvalidPage = (n: number): boolean => isNaN(n) || n < 0;

const getInputFileName = () => {
  const input = Deno.args[0].trim();
  if (!input) throw new SyntaxError("No input provided.");
  return input;
};

async function main() {
  const input = getInputFileName();
  console.log(`Processing ${input}...`);

  const { userStartPage, userEndPage, userPages } = await getInputFileData(input);
  const chunkSize = clamp(Math.floor((userPages + 1) / 20), 5, 25);
  console.log(`...${userPages} pages (${userStartPage + 1} to ${userEndPage + 1})...`);

  for (let page = userStartPage; page < userEndPage + chunkSize; page += chunkSize) {
    if (page >= userEndPage) break;
    const end = Math.min(page + chunkSize - 1, userEndPage);
    const cent = Math.min(((end / userEndPage) * 100), 100);
    console.log(`[${cent.toFixed(2)}%] Processing pages ${page + 1} to ${end + 1}...`);
    await performMagick(input, page, end);
  }
  console.log("Done!");
}

try {
  await main();
  Deno.exit(0);
} catch (err) {
  console.error(err);
  alert();
  Deno.exit(1);
}
