export const BRIDGE_URL = 'http://127.0.0.1:8765';

export const BATCH_MAX_ATTEMPTS = 2;
export const BATCH_BASE_BACKOFF_MS = 8000;
export const BATCH_MAX_BACKOFF_MS = 120000;
export const INTER_BATCH_DELAY_MS = 12000;

export const DELIMITER = '[[IMAGE_BREAK]]';

export const PROMPT_TEMPLATE = (n, delimiter) =>
`I've attached ${n} image${n === 1 ? '' : 's'}. Transcribe each image VERBATIM into GitHub-Flavored Markdown.

Verbatim rules (non-negotiable):
- Copy the visible text EXACTLY as it appears. Do NOT summarise, paraphrase, rephrase, translate, correct spelling or grammar, reorder, or invent any content.
- Include every visible character: numbering, punctuation, dashes, parentheses, question marks, page/question numbers, option letters (A, B, C, D), etc.

Formatting rules (Markdown for structure only, never for embellishment):
- Tables: use GFM pipe tables (with a header separator row).
- Headings: use #, ##, ### where the image shows visually distinct headings.
- Lists: use - for bulleted lists and 1. 2. 3. for numbered lists, matching the image.
- Emphasis: use **bold** and *italic* only where visually present.
- Math: use inline $...$ or block $$...$$ when the image shows mathematical notation. Do NOT convert plain numbers into math.
- Code / monospace blocks: use fenced \`\`\` code blocks only when the image shows code or monospace text.
- Do NOT wrap the ENTIRE response in a single code fence.
- Do NOT add commentary, introductions, explanations, image descriptions, filenames, or your own image/page numbering.

Output structure (STRICT):
- Before EACH image's transcription, output one line containing exactly the token [[N=k]] where k is the 1-based image position: [[N=1]] for the first image, [[N=2]] for the second, and so on up to [[N=${n}]]. This ordinal marker line is NOT part of the transcription; it is only a label for what follows.
- Type [[N=k]] literally. Do NOT wrap it in markdown, code fences, quotes, HTML, or escapes.
${n === 1 ? '- Do NOT output any delimiter between images (there is only one image).' :
`- Between consecutive image blocks, output the LITERAL delimiter token below on its own line, and nothing else on that line. Type it exactly, no markdown wrapping:

${delimiter}

- Your response must contain exactly ${n - 1} occurrence${(n - 1) === 1 ? '' : 's'} of that delimiter.
- Output the ${n} blocks in the same order the images were attached. Do NOT output the delimiter before [[N=1]] or after the last block.`}

Begin your response with the line [[N=1]] followed immediately on the next line by the first character of image 1.`;
