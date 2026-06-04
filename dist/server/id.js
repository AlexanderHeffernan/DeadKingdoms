let nextId = 1;
export function id(prefix) {
    nextId += 1;
    return `${prefix}${nextId.toString(36)}`;
}
