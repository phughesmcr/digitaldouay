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
const MAX_TOKENS = 6114 as const;
const TEMPERATURE = 0.0 as const;
const INPUT_DOLLARS_PER_MILLION_TOKENS = 3.00 as const;
const OUTPUT_DOLLARS_PER_MILLION_TOKENS = 15.00 as const;

const USER_PROMPT =
  `You are a highly skilled assistant specializing in transcribing old manuscripts and Old English fonts exactly. You have perfect vision and pay great attention to detail. Your task is to accurately read and extract text from an image perfectly. Follow these instructions carefully:

1. Examine the attached image of a Douay-Rheims Bible manuscript page from 1582. Take a close look at how the page is formatted and think how the output should be structured.

2. Read the text perfectly as-is and extract the text verbatim. Follow these guidelines:
  - Read the main body of the text first (outlined in red)
  - Remove hyphenation where text is broken by column breaks
  - Normalize drop-capitals
  - Replace characters no longer in use (e.g., "ſ" with "s", "Vv" with "W")
  - Ignore centered running headers at the top of the page which simply repeat the chapter or book title
  - Stick to the text on the page verbatim

3. For the main body of text (central column, outlined in red):
  - Extract the text into plain markdown format suitable for a screen-reader
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

Begin your response with the extracted text in the specified format. Do not include any explanations or comments about your process.`;

type HeaderProps = {
  inputPath: string;
  inputTokens: number;
  outputTokens: number;
  elapsedTime: number;
  cost: number;
};

const cleanPrompt = (prompt: string): string => prompt.replaceAll(/^[\s\n+]/g, "").replaceAll(/\n+/g, "\n").trim();

const cleanClaudeResponse = (text: string): string => text.replace(/```markdown\n/g, "").replace(/```/g, "").trim();

const createYAMLHeader = (props: Record<string, string | number>): string => `---\n${propsToString(props)}\n---`;

const escapePath = (path: string): string => path.replaceAll(/\\/g, "\\\\");

const getCompletedPercent = (i: number, start: number, end: number): number => {
  return Math.round(((i - start) / ((end + 1) - start)) * 100);
};

const getDurationSeconds = (startMs: number, endMs: number): number => ((endMs - startMs) / 1000);

const getPngFiles = (args: string[]): string[] => args.filter((arg) => arg.endsWith(".png"));

const loadImageToBase64 = async (path: string): Promise<string> => encodeBase64(await Deno.readFile(path));

const propsToString = (props: Record<string, string | number>): string => {
  return Object.entries(props).map(([key, value]) => `${key}: ${value}`).join("\n");
};

const calculateCost = (inputTokens: number, outputTokens: number): number => {
  const inputPrice = (inputTokens / 1e6) * INPUT_DOLLARS_PER_MILLION_TOKENS;
  const outputPrice = (outputTokens / 1e6) * OUTPUT_DOLLARS_PER_MILLION_TOKENS;
  return (inputPrice + outputPrice);
};

const createChatCompletion = (agent: Anthropic, b64Image: string) => {
  return agent.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    // system: cleanPrompt(""),
    temperature: TEMPERATURE,
    messages: [{
      "role": "user",
      "content": [
        {
          "type": "image",
          "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": b64Image,
          },
        },
        { "type": "text", "text": cleanPrompt(USER_PROMPT) },
      ],
    }],
  }, {
    headers: { "anthropic-beta": "max-tokens-3-5-sonnet-2024-07-15" },
  });
};

const createOutput = (props: HeaderProps, text = "") => {
  const { inputPath, inputTokens, outputTokens, elapsedTime, cost } = props;
  const header = createYAMLHeader({
    "path": `"${escapePath(inputPath)}"`,
    "input_tokens": inputTokens,
    "output_tokens": outputTokens,
    "elapsed_time_s": elapsedTime,
    "approx_cost_usd": cost,
    "manual_edit": "false",
  });
  const body = cleanClaudeResponse(text);
  return `${header}\n${body}`;
};

async function main(agent: Anthropic, paths: string[]): Promise<void> {
  const startTime = performance.now();
  let lastTime = startTime;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const totalTokens = () => totalInputTokens + totalOutputTokens;

  for (let i = 0; i < paths.length; i++) {
    try {
      const inputPath = paths[i];
      console.log(`[${getCompletedPercent(i, 0, paths.length)}%] Processing "${inputPath}"...`);

      // prompt the API
      const b64Image = await loadImageToBase64(inputPath);
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
      const output = createOutput(
        { inputPath, inputTokens, outputTokens, elapsedTime, cost },
        // @ts-ignore - completion[0].text does exist
        completion.content[0].text,
      );
      await Deno.writeTextFile(`${inputPath}.md`, output, { create: true });

      // update this last so we don't take write time into account
      lastTime = performance.now();
    } catch (error) {
      lastTime = performance.now();
      console.error(error);
      if (confirm("Abort?")) {
        const time = getDurationSeconds(startTime, lastTime).toFixed(2);
        const cost = calculateCost(totalInputTokens, totalOutputTokens).toFixed(3);
        throw new Error(`Failed after ${time}s. Used ${totalTokens()} tokens, approximately $${cost}.`);
      }
    }
  }
  const endTime = performance.now();
  const totalTimeSeconds = getDurationSeconds(startTime, endTime).toFixed(2);
  const cost = calculateCost(totalInputTokens, totalOutputTokens).toFixed(3);
  console.log(`Finished successfully in ${totalTimeSeconds}s. Used ${totalTokens()} tokens, approximately $${cost}.`);
}

try {
  console.clear();
  const paths = getPngFiles(Deno.args);
  if (!paths.length) {
    throw new SyntaxError("Unrecoverable error: No .png files provided.\n");
  }
  const env = await load({ export: true });
  const agent = new Anthropic({ apiKey: env["ANTHROPIC_API_KEY"] || Deno.env.get("ANTHROPIC_API_KEY") });
  await main(agent, paths);
  confirm("Press Enter to exit.");
  Deno.exit(0);
} catch (err) {
  console.error(err);
  confirm("Press Enter to exit.");
  Deno.exit(1);
}
