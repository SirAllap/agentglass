/** "1 file", "0 files", "1,272 files": the count a knowledge source and the read summary both print (it said "1 files"). */
export const fileCount = (n: number): string => (n === 1 ? "1 file" : `${n.toLocaleString("en-US")} files`);
