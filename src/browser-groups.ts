export function renameGroupInRegistry(
  groups: readonly string[],
  oldName: string,
  newName: string,
): string[] {
  const renamed = groups.map((group) => group === oldName ? newName : group);
  return renamed.filter((group, index) => renamed.indexOf(group) === index);
}

export function deleteGroupFromRegistry(
  groups: readonly string[],
  name: string,
): string[] {
  return groups.filter((group) => group !== name);
}
