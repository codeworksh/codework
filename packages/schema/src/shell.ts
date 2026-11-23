/** A path as one shell word: as is when it needs no quoting, else single-quoted. */
export const shellQuoted = (path: string) => (/^[\w./~-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`);
