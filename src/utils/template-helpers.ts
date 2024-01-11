export const importFiles = (files: string[], prefix: string = "file") =>
  files
    .map(
      (file, index) =>
        `import ${prefix}${index} from '${file.replace(".ts", "")}'`
    )
    .join("\n");

export const methodFactory = (
  input: any[],
  methodName: string,
  importedKey: string,
  importedVarProps: string[]
) => {
  return input.map((item, index) => {
    const argsString: string[] = [];

    for (const arg of importedVarProps) {
      argsString.push(`${importedKey}${index}.${arg}`);
    }
    return `${methodName}(${argsString.join(", ")})`;
  });
};
