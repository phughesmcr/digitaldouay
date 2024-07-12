#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env="ANTHROPIC_API_KEY" --allow-net

/**
 * @module      OCR_CLAUDE
 * @description Use Anthropic's Claude 3.5 to read text from an image and produce markdown
 * @author      P. Hughes <code@phugh.es> (https://phugh.es)
 * @copyright   2024. All rights reserved.
 * @license     MIT
 */

import { load } from "jsr:@std/dotenv";
import { encodeBase64 } from "jsr:@std/encoding";
import Anthropic from "npm:@anthropic-ai/sdk";

const MODEL = "claude-3-5-sonnet-20240620" as const;
const MAX_TOKENS = 4096 as const;
const TEMPERATURE = 0.2 as const;
const INPUT_DOLLARS_PER_MILLION_TOKENS = 3.00 as const;
const OUTPUT_DOLLARS_PER_MILLION_TOKENS = 15.00 as const;

type HeaderProps = {
  jpgPath: string;
  inputTokens: number;
  outputTokens: number;
  elapsedTime: number;
  price: number;
};

const cleanPrompt = (prompt: string): string => prompt.replaceAll(/^[\s\n+]/g, "").replaceAll(/\n+/g, "\n").trim();

const cleanClaudeResponse = (text: string): string => text.replace(/```markdown\n/g, "").replace(/```/g, "").trim();

const createYAMLHeader = (props: Record<string, string | number>): string => `---\n${propsToString(props)}\n---`;

const escapePath = (path: string): string => path.replaceAll(/\\/g, "\\\\");

const getCompletedPercent = (i: number, start: number, end: number): number => Math.round(((i - start) / ((end + 1) - start)) * 100);

const getDurationSeconds = (startMs: number, endMs: number): number => ((endMs - startMs) / 1000);

const getJpgFiles = (args: string[]): string[] => args.filter((arg) => (arg.endsWith(".jpg") || arg.endsWith(".jpeg")));

const loadImageToBase64 = async (path: string): Promise<string> => encodeBase64(await Deno.readFile(path));

const propsToString = (props: Record<string, string | number>): string => Object.entries(props).map(([key, value]) => `${key}: ${value}`).join("\n");

const BASE_PROMPT = cleanPrompt(`You are a highly skilled assistant specializing in detailed reading of old manuscripts and Old English fonts. Your task is to accurately read and extract text from an image perfectly. Follow these instructions carefully:

1. Examine the attached image of a 1500s Douay-Rheims Bible manuscript page. Look closely at all parts of the page, including margins, and how it is laid out.

2. Carefully read and extract the text verbatim, focusing on accuracy. Follow these guidelines:
  - Remove hyphenation where text is broken by column breaks
  - Normalize drop-capitals
  - Replace characters no longer in use (e.g., "ſ" with "s", "Vv" with "W")
  - Ignore any watermarks or coats of arms
  - Stick to the text on the page verbatim
  - Ignore running headers which simply repeat the chapter or book title
  - Remember that sometimes the margin and body text are very close together. Be careful. Avoid running main body text into the margin or vice-versa.

3. For the main body of text (central column of the page):
  - Extract the text into plain markdown format
  - Preserve typography such as italics and bold
  - Include verse numbers from the margin in the main body of text replacing them and the relevant "†" symbol in the main text with a HTML "sup" tag

4. Handle margin content as follows:
  - There might be verse numbers in a margin, since this is a bible manuscript. Include those in the main body of text as instructed.
  - The outer margin contains comments: Convert text into HTML "aside" tags
  - The inner margin contains cross-references (inc. to bible verses and other sources): Convert text into markdown footnotes (e.g., "[^1]")
  - Often the margin text and body text are very close together. Try extra hard to make sure they are correctly separated
  - Do not repeat references, verse numbers, or footnotes
  - Read every piece of text in the margins to the best of your ability
  - Match the position of each footnote to its indicated (or closest relevant) place in the main body of text

5. Formatting and typography:
  - Use good, well-formatted, usable markdown
  - Match typography such as italics and bold from the original text
  - Include horizontal rules from the original document using "<hr>"

6. Accuracy is crucial:
  - Take your time and be diligent
  - Think step-by-step to ensure you capture all details
  - Remember that perfect verbatim extraction is essential because this is a sacred text
  - You may consult your knowledge of the Douay-Rheims Bible to ensure accuracy, but imagination is discouraged

7. Final output:
  - Present your extracted text in a single, cohesive markdown document
  - Include all main text, asides, and footnotes in their appropriate positions, keeping the markdown readable
  - Ensure the output is suitable for visually impaired researchers using screen-readers

Begin your response with the extracted text in the specified format. Do not include any explanations or comments about your process.`);

const calculateCost = (inputTokens: number, outputTokens: number): number => {
  const inputPrice = (inputTokens / 1e6) * INPUT_DOLLARS_PER_MILLION_TOKENS;
  const outputPrice = (outputTokens / 1e6) * OUTPUT_DOLLARS_PER_MILLION_TOKENS;
  return (inputPrice + outputPrice);
};

const createChatCompletion = (agent: Anthropic, b64Image: string) => agent.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: BASE_PROMPT,
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
        { "type": "text", "text": BASE_PROMPT }
      ]
    }],
  });

const createOutput = (props: HeaderProps, text = "") => {
  const { jpgPath, inputTokens, outputTokens, elapsedTime, price } = props;
  const header = createYAMLHeader({
    "path": `"${escapePath(jpgPath)}"`,
    "input_tokens": inputTokens,
    "output_tokens": outputTokens,
    "elapsed_time_s": elapsedTime,
    "approx_cost_usd": price,
    "manual_edit": "false",
  });
  const body = cleanClaudeResponse(text);
  return `${header}\n${body}`;
}

async function main(agent: Anthropic): Promise<void> {
  const files = getJpgFiles(Deno.args);
  if (!files.length) {
    throw new SyntaxError("Unrecoverable error: No .jpg or .jpeg files provided.\n");
  }

  const startTime = performance.now();
  let lastTime = startTime;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let i = 0; i < files.length; i++) {
    try {
      const jpgPath = files[i];
      console.log(`[${getCompletedPercent(i, 0, files.length)}%] Processing "${jpgPath}"...`);

      // prompt the API
      const b64Image = await loadImageToBase64(jpgPath);
      const completion = await createChatCompletion(agent, b64Image);

      // update token counts
      const inputTokens = completion.usage.input_tokens || 0;
      const outputTokens = completion.usage.output_tokens || 0;
      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;

      // feedback
      const elapsedTime = getDurationSeconds(lastTime, performance.now());
      const cost = calculateCost(inputTokens, outputTokens);
      console.log(`Done. [${elapsedTime.toFixed(2)}s, ${inputTokens + outputTokens} tokens, $${cost.toFixed(3)}].\n`);

      // create and write the markdown output
      // @ts-ignore - completion[0].text does exist
      const output = createOutput({ jpgPath, inputTokens, outputTokens, elapsedTime, cost }, completion.content[0].text);
      await Deno.writeTextFile(`${jpgPath}.md`, output, { create: true });

      // update this last so we don't take write time into account
      lastTime = performance.now();
    } catch (error) {
      lastTime = performance.now();
      console.error(error);
      if (confirm("Abort?")) {
        throw new Error(`Exited with error after ${getDurationSeconds(startTime, lastTime).toFixed(2)}s. Used ${totalInputTokens + totalOutputTokens} tokens, approximately $${calculateCost(totalInputTokens, totalOutputTokens).toFixed(3)}.`);
      };
    }
  }
  const endTime = performance.now();
  const totalTimeSeconds = getDurationSeconds(startTime, endTime).toFixed(2);
  const cost = calculateCost(totalInputTokens, totalOutputTokens).toFixed(3);
  console.log(`Finished successfully in ${totalTimeSeconds} seconds. Used ${totalInputTokens + totalOutputTokens} tokens, approximately $${cost}.`);
}

try {
  console.clear();
  const env = await load();
  const agent = new Anthropic({ apiKey: env["ANTHROPIC_API_KEY"] });
  await main(agent);
  confirm("Press Enter to exit.");
  Deno.exit(0);
} catch (err) {
  console.error(err);
  confirm("Press Enter to exit.");
  Deno.exit(1);
}
