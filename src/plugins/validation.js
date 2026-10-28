import { PluginError } from "./errors.js";

const TYPES = new Set(["object", "string", "number", "integer", "boolean", "array"]);

function typeMatches(type, value) {
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  return false;
}

function labelFor(path) {
  return path.length ? path.join(".") : "value";
}

function validateValue(schema, value, path, errors) {
  const type = schema?.type;
  if (type && TYPES.has(type) && !typeMatches(type, value)) {
    errors.push(`${labelFor(path)} must be ${type === "integer" ? "an integer" : `a ${type}`}.`);
    return;
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${labelFor(path)} must be at least ${schema.minLength} characters.`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${labelFor(path)} must be at most ${schema.maxLength} characters.`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${labelFor(path)} has an invalid format.`);
    }
    if (schema.format === "uri") {
      try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
      } catch {
        errors.push(`${labelFor(path)} must be a valid http or https URL.`);
      }
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${labelFor(path)} must be at least ${schema.minimum}.`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${labelFor(path)} must be at most ${schema.maximum}.`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${labelFor(path)} must contain at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}.`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${labelFor(path)} must contain at most ${schema.maxItems} item${schema.maxItems === 1 ? "" : "s"}.`);
    }
    if (schema.items) value.forEach((item, index) => validateValue(schema.items, item, [...path, String(index)], errors));
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${labelFor(path)} must be one of: ${schema.enum.join(", ")}.`);
  }
  if (type === "object" && value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties || {};
    for (const key of schema.required || []) {
      if (value[key] === undefined || value[key] === null || value[key] === "") {
        errors.push(`${labelFor([...path, key])} is required.`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (!properties[key]) {
        if (schema.additionalProperties === false) errors.push(`${labelFor([...path, key])} is not supported.`);
        continue;
      }
      validateValue(properties[key], child, [...path, key], errors);
    }
  }
}

export function validateInput(schema, input = {}) {
  const errors = [];
  validateValue(schema || { type: "object", properties: {} }, input, [], errors);
  if (errors.length) {
    throw new PluginError(errors[0], 400, "invalid_tool_input");
  }
  return input;
}

export function validateFields(fields = [], input = {}) {
  const errors = [];
  const result = {};
  for (const field of fields) {
    const raw = input?.[field.key];
    const empty = raw === undefined || raw === null || raw === "";
    if (field.required && empty) {
      errors.push(`${field.label} is required.`);
      continue;
    }
    if (empty) continue;
    if (field.type === "password" || field.type === "text" || field.type === "url") {
      if (typeof raw !== "string") {
        errors.push(`${field.label} must be text.`);
        continue;
      }
      if (field.maxLength && raw.length > field.maxLength) {
        errors.push(`${field.label} is too long.`);
        continue;
      }
      if (field.type === "url") {
        try {
          const url = new URL(raw);
          if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
        } catch {
          errors.push(`${field.label} must be a valid http or https URL.`);
          continue;
        }
      }
      result[field.key] = raw;
    } else if (field.type === "select") {
      if (!field.options?.some(option => option.value === raw)) {
        errors.push(`${field.label} has an unsupported value.`);
        continue;
      }
      result[field.key] = raw;
    }
  }
  if (errors.length) throw new PluginError(errors[0], 400, "invalid_configuration");
  return result;
}

export function splitSecretFields(fields = [], input = {}) {
  const config = {};
  const credentials = {};
  for (const field of fields) {
    if (input[field.key] === undefined || input[field.key] === "") continue;
    if (field.secret) credentials[field.key] = input[field.key];
    else config[field.key] = input[field.key];
  }
  return { config, credentials };
}
