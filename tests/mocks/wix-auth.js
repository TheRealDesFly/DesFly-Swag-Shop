export function elevate(method) {
  return (...args) => method(...args);
}
