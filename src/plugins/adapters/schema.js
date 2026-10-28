export function text(description, options = {}) {
  return { type: "string", description, ...options };
}

export function integer(description, options = {}) {
  return { type: "integer", description, ...options };
}

export function number(description, options = {}) {
  return { type: "number", description, ...options };
}

export function boolean(description, options = {}) {
  return { type: "boolean", description, ...options };
}

export function object(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

export function listResult(items, key = "results") {
  return { [key]: Array.isArray(items) ? items : [], count: Array.isArray(items) ? items.length : 0 };
}
