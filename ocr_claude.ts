#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net

/**
 * @module      OCR_CLAUDE
 * @description Use Anthropic's Claude 3.5 to read text from an image and produce markdown
 * @author      P. Hughes <code@phugh.es> (https://phugh.es)
 * @copyright   2024. All rights reserved.
 * @license     MIT
 */

import "jsr:@std/dotenv/load";
import { encodeBase64 } from "jsr:@std/encoding";
import Anthropic from "npm:@anthropic-ai/sdk";

const AGENT = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")});
const MODEL = "claude-3-5-sonnet-20240620" as const;
const MAX_TOKENS = 4096 as const;
const TEMPERATURE = 0.0 as const;
const INPUT_DOLLARS_PER_MILLION_TOKENS = 3.00 as const;
const OUTPUT_DOLLARS_PER_MILLION_TOKENS = 15.00 as const;

const getCompletedPercent = (i: number, start: number, end: number) => Math.round(((i - start) / ((end + 1) - start)) * 100);

const isOdd = (num: number) => num % 2 === 1;

const loadImageToBase64 = async (path: string): Promise<string> => encodeBase64(await Deno.readFile(path));

const filterArgsForJpg = (args: string[]): string[] => args.filter((arg) => (arg.endsWith(".jpg") || arg.endsWith(".jpeg")));

const propsToString = (props: Record<string, string | number>): string => Object.entries(props).map(([key, value]) => `${key}: ${value}`).join("\n");

const createYAMLHeader = (props: Record<string, string | number>): string => `---\n${propsToString(props)}\n---`;

const replaceEvenMarginRefs = (str: string): string => str.replaceAll("{{REFERENCE_MARGIN}}", "left").replaceAll("{{COMMENT_MARGIN}}", "right");

const replaceOddMarginRefs = (str: string):string => str.replaceAll("{{REFERENCE_MARGIN}}", "right").replaceAll("{{COMMENT_MARGIN}}", "left");

const cleanReturnedText = (text: string): string => text.replace(/```markdown\n/g, "").replace(/```/g, "").trim();

const getDurationSeconds = (startMs: number, endMs: number): string => ((endMs - startMs) / 1000).toFixed(2);

const getPageNumberFromFilename = (filename: string): number => parseInt(filename.split("-")[1].split(".")[0], 10);

const BASE_PROMPT = `You are a highly skilled assistant specializing in reading old manuscripts and Old English fonts. Your task is to accurately read and extract text from an image of a 1500s Douay-Rheims Bible manuscript. Follow these instructions carefully:

1. Examine the attached image of a manuscript page.

2. Read and extract the text verbatim, focusing on accuracy. Follow these guidelines:
  - Remove hyphenation where text is broken by column breaks
  - Normalize drop-capitals
  - Replace characters no longer in use (e.g., "ſ" with "s", "Vv" with "W")
  - Ignore any watermarks or coats of arms
  - Stick to the text on the page verbatim
  - Ignore running headers which simply repeat the chapter or book title

3. For the main body of text (central column of the page):
  - Extract the text in plain markdown format
  - Preserve typography such as italics and bold
  - Include verse numbers from the margin in the main body of text replacing the relevant "†" symbol in the main text with a HTML "sup" tag

4. Handle margin content as follows:
  - There might be verse numbers in a margin, since this is a bible manuscript. Include those in the main body of text as instructed.
  - On the {{COMMENT_MARGIN}} margin: Convert text into HTML "aside" tags
  - On the {{REFERENCE_MARGIN}} margin: Convert text (inc. cross-references to bible verses and other sources) into markdown footnotes (e.g., "[^1]")
  - Often the margin text and body text are very close together. Try extra hard to make sure they are correctly separated.
  - Do not repeat references or footnotes
  - Read every piece of text in the margins to the best of your ability
  - Match the position of each footnote to its indicated (or closest relevant) place in the main body of text

5. Formatting and typography:
  - Use good, well-formatted, usable markdown
  - Follow the CommonMark Markdown Specification
  - Match typography such as italics and bold from the original text
  - Include horizontal rules from the original document using "---"

6. Accuracy is crucial:
  - Take your time and be diligent
  - Think step-by-step to ensure you capture all details
  - Remember that perfect verbatim extraction is essential because this is a sacred text
  - You may consult your knowledge of the Douay-Rheims Bible to ensure accuracy, but imagination is discouraged

7. Final output:
  - Present your extracted text in a single, cohesive markdown document
  - Include all main text, asides, and footnotes in their appropriate positions, keeping the markdown readable
  - Ensure the output is suitable for visually impaired researchers using screen-readers

Begin your response with the extracted text in the specified format. Do not include any explanations or comments about your process.`;

// position of the margins changes based on odd/even page numbers
const ODD_PROMPT = replaceOddMarginRefs(BASE_PROMPT);
const EVEN_PROMPT = replaceEvenMarginRefs(BASE_PROMPT);

const calculatePrice = (inputTokens: number, outputTokens: number): string => {
  const inputPrice = (inputTokens / 1e6) * INPUT_DOLLARS_PER_MILLION_TOKENS;
  const outputPrice = (outputTokens / 1e6) * OUTPUT_DOLLARS_PER_MILLION_TOKENS;
  return (inputPrice + outputPrice).toFixed(3);
};

const createChatCompletion = (b64Image: string, prompt: string) => AGENT.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: prompt,
    temperature: TEMPERATURE,
    messages: [{
      "role": "user", "content": [
        {
          "type": "image",
          "source": {
            "type": "base64",
            "media_type": "image/jpeg",
            "data": b64Image,
          }
        },
        { "type": "text", "text": prompt }
      ]
    }],
  });

async function main() {
  const startTime = performance.now();
  let lastTime = startTime;

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const files = filterArgsForJpg(Deno.args);
  if (!files.length) throw new Error("No files found to process.");

  for (let i = 0; i < files.length; i++) {
    try {
      const jpgPath = files[i];
      console.log(`[${getCompletedPercent(i, 0, files.length)}%] Processing "${jpgPath}"...`);

      // prompt the API
      const b64Image = await loadImageToBase64(jpgPath);
      const pageNumber = getPageNumberFromFilename(jpgPath);
      const userPrompt = isOdd(pageNumber) ? ODD_PROMPT : EVEN_PROMPT;
      const completion = await createChatCompletion(b64Image, userPrompt);

      // update token counts
      const inputTokens = completion.usage.input_tokens || 0;
      const outputTokens = completion.usage.output_tokens || 0;
      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;

      // feedback
      const elapsedTime = getDurationSeconds(lastTime, performance.now());
      const price = calculatePrice(inputTokens, outputTokens);
      console.log(`\t...[${elapsedTime}s, ${inputTokens + outputTokens} tokens, $${price}].`);

      // construct the markdown result
      const yamlHeader = createYAMLHeader({
        "path": `"${jpgPath}"`,
        "input_tokens": inputTokens,
        "output_tokens": outputTokens,
        "elapsed_time_s": elapsedTime,
        "approx_cost_usd": price,
        "manual_edit": "false",
      });
      // @ts-ignore - content[0].text does exist
      const markdownBody = cleanReturnedText(completion.content[0].text ?? "");

      // write the markdown file
      const outputPath = `$${jpgPath}.md`;
      await Deno.writeTextFile(`${outputPath}`, `${yamlHeader}\n${markdownBody}`, { create: true });

      // update this last so we don't take write time into account
      lastTime = performance.now();
    } catch (error) {
      lastTime = performance.now();
      console.error(error);
      if (confirm("Abort?")) {
        console.log(`Exited with error after ${getDurationSeconds(startTime, lastTime)}s. Used ${totalInputTokens + totalOutputTokens} tokens, approximately $${calculatePrice(totalInputTokens, totalOutputTokens)}.`);
        Deno.exit(1);
      };
    }
  }
  const endTime = performance.now();
  const totalTimeSeconds = getDurationSeconds(startTime, endTime);
  const price = calculatePrice(totalInputTokens, totalOutputTokens);
  console.log(`Finished successfully in ${totalTimeSeconds} seconds. Used ${totalInputTokens + totalOutputTokens} tokens, approximately $${price}.`);
  Deno.exit(0);
}

await main();
