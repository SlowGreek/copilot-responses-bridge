const MAX_INPUT_ITEMS = 256;
const MAX_TOOLS = 128;
const MAX_STRING_BYTES = 2 * 1024 * 1024;
const MAX_SCHEMA_BYTES = 256 * 1024;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/u;
const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const TEXT_VERBOSITIES = new Set(["low", "medium", "high"]);
const HOSTED_SEARCH_TYPES = new Set(["web_search", "web_search_preview"]);
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;

export class BridgeRequestError extends Error {
  constructor(message, { statusCode = 400, code = "invalid_request_error" } = {}) {
    super(message);
    this.name = "BridgeRequestError";
    this.statusCode = statusCode;
    this.code = code;
    this.publicMessage = message;
  }
}

export function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function invalid(message) {
  throw new BridgeRequestError(message);
}

function assertJsonComplexity(value) {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > MAX_JSON_NODES) invalid("request body is too complex");
    if (current.depth > MAX_JSON_DEPTH) invalid("request body is too deeply nested");
    if (Array.isArray(current.value)) {
      for (const entry of current.value) stack.push({ value: entry, depth: current.depth + 1 });
    } else if (isPlainObject(current.value)) {
      for (const entry of Object.values(current.value)) {
        stack.push({ value: entry, depth: current.depth + 1 });
      }
    }
  }
}

function boundedString(value, label, { optional = false } = {}) {
  if (optional && value === undefined) return;
  if (typeof value !== "string") invalid(`${label} must be a string`);
  if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) invalid(`${label} is too large`);
}

function validateInputContent(content, label) {
  if (!Array.isArray(content) || !content.length) invalid(`${label} must be a non-empty array`);
  for (const [index, part] of content.entries()) {
    if (!isPlainObject(part)) invalid(`${label}[${index}] must be an object`);
    if (part.type === "input_text") {
      boundedString(part.text, `${label}[${index}].text`);
      continue;
    }
    if (part.type === "input_image") {
      boundedString(part.image_url, `${label}[${index}].image_url`);
      continue;
    }
    invalid(`${label}[${index}] has unsupported type`);
  }
}

function validateOutputContent(content, label) {
  if (!Array.isArray(content) || !content.length) invalid(`${label} must be a non-empty array`);
  for (const [index, part] of content.entries()) {
    if (!isPlainObject(part) || part.type !== "output_text") {
      invalid(`${label}[${index}] must be output_text`);
    }
    boundedString(part.text, `${label}[${index}].text`);
  }
}

function validateInput(input) {
  if (!Array.isArray(input) || input.length > MAX_INPUT_ITEMS) {
    invalid(`input must contain at most ${MAX_INPUT_ITEMS} items`);
  }
  for (const [index, item] of input.entries()) {
    const label = `input[${index}]`;
    if (!isPlainObject(item)) invalid(`${label} must be an object`);
    if (item.role === "system") {
      boundedString(item.content, `${label}.content`);
      continue;
    }
    if (item.role === "user") {
      validateInputContent(item.content, `${label}.content`);
      continue;
    }
    if (item.role === "assistant") {
      validateOutputContent(item.content, `${label}.content`);
      continue;
    }
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      boundedString(item.call_id, `${label}.call_id`);
      boundedString(item.name, `${label}.name`);
      boundedString(
        item.type === "function_call" ? item.arguments : item.input,
        `${label}.${item.type === "function_call" ? "arguments" : "input"}`,
      );
      continue;
    }
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      boundedString(item.call_id, `${label}.call_id`);
      if (typeof item.output === "string") {
        boundedString(item.output, `${label}.output`);
      } else if (Array.isArray(item.output)) {
        validateInputContent(item.output, `${label}.output`);
      } else {
        invalid(`${label}.output must be a string or content array`);
      }
      continue;
    }
    if (item.type === "reasoning") {
      if (!Array.isArray(item.summary)) invalid(`${label}.summary must be an array`);
      for (const [summaryIndex, summary] of item.summary.entries()) {
        if (!isPlainObject(summary) || summary.type !== "summary_text") {
          invalid(`${label}.summary[${summaryIndex}] must be summary_text`);
        }
        boundedString(summary.text, `${label}.summary[${summaryIndex}].text`);
      }
      continue;
    }
    if (item.type === "item_reference") {
      invalid("item_reference requires provider-side stored responses, which this bridge does not keep");
    }
    invalid(`${label} has unsupported shape`);
  }
}

function validateJsonSchema(schema, label) {
  if (!isPlainObject(schema)) invalid(`${label} must be an object`);
  if (Buffer.byteLength(JSON.stringify(schema), "utf8") > MAX_SCHEMA_BYTES) {
    invalid(`${label} is too large`);
  }
}

function validateTools(tools) {
  if (tools === undefined) return [];
  if (!Array.isArray(tools) || tools.length > MAX_TOOLS) {
    invalid(`tools must contain at most ${MAX_TOOLS} entries`);
  }
  const names = new Set();
  for (const [index, tool] of tools.entries()) {
    const label = `tools[${index}]`;
    if (!isPlainObject(tool)) invalid(`${label} must be an object`);
    if (HOSTED_SEARCH_TYPES.has(tool.type)) continue;
    if (tool.type !== "function" && tool.type !== "custom") {
      invalid(`${label} has unsupported type`);
    }
    if (typeof tool.name !== "string" || !TOOL_NAME.test(tool.name)) {
      invalid(`${label}.name is invalid`);
    }
    if (names.has(tool.name)) invalid(`duplicate tool name '${tool.name}'`);
    names.add(tool.name);
    boundedString(tool.description, `${label}.description`, { optional: true });
    if (tool.type === "function") validateJsonSchema(tool.parameters ?? {}, `${label}.parameters`);
  }
  return tools;
}

function validateToolChoice(toolChoice, tools) {
  if (toolChoice === undefined) return;
  if (["auto", "none", "required"].includes(toolChoice)) return;
  if (!isPlainObject(toolChoice) || toolChoice.type !== "function" || typeof toolChoice.name !== "string") {
    invalid("tool_choice is invalid");
  }
  if (!tools.some((tool) => tool.name === toolChoice.name)) {
    invalid("tool_choice references an unknown tool");
  }
}

function validateText(text) {
  if (text === undefined) return;
  if (!isPlainObject(text)) invalid("text must be an object");
  if (text.verbosity !== undefined && !TEXT_VERBOSITIES.has(text.verbosity)) {
    invalid("text.verbosity is invalid");
  }
  if (text.format === undefined) return;
  if (!isPlainObject(text.format)) invalid("text.format must be an object");
  if (text.format.type === "json_object") return;
  if (text.format.type !== "json_schema") invalid("text.format.type is unsupported");
  boundedString(text.format.name, "text.format.name");
  boundedString(text.format.description, "text.format.description", { optional: true });
  validateJsonSchema(text.format.schema, "text.format.schema");
  if (text.format.strict !== undefined && typeof text.format.strict !== "boolean") {
    invalid("text.format.strict must be boolean");
  }
}

export function validateResponsesRequest(value, { allowedModels } = {}) {
  if (!isPlainObject(value)) invalid("request body must be a JSON object");
  assertJsonComplexity(value);
  boundedString(value.model, "model");
  if (allowedModels && !allowedModels.has(value.model)) {
    throw new BridgeRequestError("model is not available", { statusCode: 404, code: "model_not_found" });
  }
  validateInput(value.input);
  boundedString(value.instructions, "instructions", { optional: true });
  if (value.stream !== undefined && typeof value.stream !== "boolean") invalid("stream must be boolean");
  if (value.store === true) invalid("store=true is unsupported; OpenCode must send complete turn history");
  if (value.previous_response_id !== undefined) {
    invalid("previous_response_id is unsupported; OpenCode must send complete turn history");
  }
  const tools = validateTools(value.tools);
  validateToolChoice(value.tool_choice, tools);
  if (value.parallel_tool_calls !== undefined && typeof value.parallel_tool_calls !== "boolean") {
    invalid("parallel_tool_calls must be boolean");
  }
  if (value.reasoning !== undefined) {
    if (!isPlainObject(value.reasoning)) invalid("reasoning must be an object");
    if (value.reasoning.effort !== undefined && !REASONING_EFFORTS.has(value.reasoning.effort)) {
      invalid("reasoning.effort is invalid");
    }
    if (value.reasoning.summary !== undefined && value.reasoning.summary !== "auto") {
      invalid("reasoning.summary is invalid");
    }
  }
  validateText(value.text);
  for (const numeric of ["max_output_tokens", "temperature", "top_p"]) {
    if (value[numeric] !== undefined && (!Number.isFinite(value[numeric]) || value[numeric] < 0)) {
      invalid(`${numeric} must be a non-negative finite number`);
    }
  }
  return {
    ...value,
    input: value.input,
    tools,
    stream: value.stream === true,
    store: false,
  };
}

function structuredInvalid(message) {
  return new BridgeRequestError(message, {
    statusCode: 502,
    code: "structured_output_invalid",
  });
}

function validateSchemaValue(value, schema, path = "$") {
  if (!isPlainObject(schema)) return;
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) {
    throw structuredInvalid(`structured output does not match enum at ${path}`);
  }
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    throw structuredInvalid(`structured output does not match const at ${path}`);
  }
  if (Array.isArray(schema.allOf)) {
    for (const entry of schema.allOf) validateSchemaValue(value, entry, path);
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.some((entry) => {
      try {
        validateSchemaValue(value, entry, path);
        return true;
      } catch {
        return false;
      }
    });
    if (!matches) throw structuredInvalid(`structured output does not match anyOf at ${path}`);
  }
  if (schema.type === "object") {
    if (!isPlainObject(value)) throw structuredInvalid(`structured output must be an object at ${path}`);
    for (const required of schema.required ?? []) {
      if (!(required in value)) throw structuredInvalid(`structured output is missing ${path}.${required}`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in value) validateSchemaValue(value[key], child, `${path}.${key}`);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) throw structuredInvalid(`structured output has unexpected ${path}.${key}`);
      }
    }
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw structuredInvalid(`structured output must be an array at ${path}`);
    for (const [index, entry] of value.entries()) validateSchemaValue(entry, schema.items ?? {}, `${path}[${index}]`);
  }
  if (schema.type === "string" && typeof value !== "string") {
    throw structuredInvalid(`structured output must be a string at ${path}`);
  }
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    throw structuredInvalid(`structured output must be a number at ${path}`);
  }
  if (schema.type === "integer" && !Number.isInteger(value)) {
    throw structuredInvalid(`structured output must be an integer at ${path}`);
  }
  if (schema.type === "boolean" && typeof value !== "boolean") {
    throw structuredInvalid(`structured output must be boolean at ${path}`);
  }
  if (schema.type === "null" && value !== null) {
    throw structuredInvalid(`structured output must be null at ${path}`);
  }
}

export function validateStructuredOutput(text, format) {
  if (!format) return;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw structuredInvalid("model returned invalid JSON for structured output");
  }
  if (format.type === "json_object" && !isPlainObject(value)) {
    throw structuredInvalid("structured output must be a JSON object");
  }
  if (format.type === "json_schema") validateSchemaValue(value, format.schema);
}

export function structuredOutputInstruction(format) {
  if (!format) return "";
  if (format.type === "json_object") return "\nReturn only one valid JSON object with no Markdown fencing.";
  return [
    "\nReturn only JSON with no Markdown fencing.",
    `The JSON must satisfy this schema: ${JSON.stringify(format.schema)}`,
  ].join("\n");
}
