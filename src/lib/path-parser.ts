const kCommandTypeRegex = /^[\t\n\f\r ]*([MLHVZCSQTAmlhvzcsqta])[\t\n\f\r ]*/;
const kFlagRegex = /^[01]/;
const kNumberRegex = /^[+-]?(([0-9]*\.[0-9]+)|([0-9]+\.)|([0-9]+))([eE][+-]?[0-9]+)?/;
const kCoordinateRegex = kNumberRegex;
const kCommaWsp = /^(([\t\n\f\r ]+,?[\t\n\f\r ]*)|(,[\t\n\f\r ]*))/;

// Custom extensions: ±delta variation suffixes and @functionName per-segment timing annotations.
// These are stripped before standard SVG parsing so the editor can open/display such paths.
const kVariationRegex = /\u00b1[+-]?(([0-9]*\.[0-9]+)|([0-9]+\.)|([0-9]+))([eE][+-]?[0-9]+)?/g;
const kAnnotationRegex = /@[a-zA-Z]+/g;
// Non-global variants for single cursor-based matching inside extractCustomExtensions.
const kDeltaRegex = /^\u00b1[+-]?(([0-9]*\.[0-9]+)|([0-9]+\.)|([0-9]+))([eE][+-]?[0-9]+)?/;
const kAnnotationSingleRegex = /^@[a-zA-Z]+/;

/** Per-command custom extension data extracted from a ±delta/@annotation-enhanced path string. */
export interface SvgItemExtensions {
    /** Per-value variation deltas parallel to item.values; null means no delta for that value. */
    deltas: (number | null)[];
    /** Timing function annotation name (without '@'), null means none. */
    annotation: string | null;
}

const kGrammar: {[key: string]: RegExp[]}  = {
    M: [kCoordinateRegex, kCoordinateRegex],
    L: [kCoordinateRegex, kCoordinateRegex],
    H: [kCoordinateRegex],
    V: [kCoordinateRegex],
    Z: [],
    C: [kCoordinateRegex, kCoordinateRegex, kCoordinateRegex, kCoordinateRegex, kCoordinateRegex, kCoordinateRegex],
    S: [kCoordinateRegex, kCoordinateRegex, kCoordinateRegex, kCoordinateRegex],
    Q: [kCoordinateRegex, kCoordinateRegex, kCoordinateRegex, kCoordinateRegex],
    T: [kCoordinateRegex, kCoordinateRegex],
    A: [kNumberRegex, kNumberRegex, kCoordinateRegex, kFlagRegex, kFlagRegex, kCoordinateRegex, kCoordinateRegex],
};

export class PathParser {

    static components(type: string, path: string, cursor: number): [number, string[][]]
    {
        const expectedRegexList = kGrammar[type.toUpperCase()];

        const components: string[][] = [];
        while (cursor <= path.length) {
            const component: string[] = [type];
            for (const regex of expectedRegexList) {
                const match = path.slice(cursor).match(regex);

                if (match !== null) {
                    component.push(match[0]);
                    cursor += match[0].length;
                    const ws = path.slice(cursor).match(kCommaWsp);
                    if (ws !== null) {
                        cursor += ws[0].length;
                    }
                } else if (component.length === 1 && components.length >= 1) {
                    return [cursor, components];
                } else {
                    throw new Error('malformed path (first error at ' + cursor + ')');
                }
            }
            components.push(component);
            if (expectedRegexList.length === 0) {
                return [cursor, components];
            }
            if (type === 'm') {
                type = 'l';
            }
            if (type === 'M') {
                type = 'L';
            }
        }
        throw new Error('malformed path (first error at ' + cursor + ')');
    }

    /**
     * Extract ±delta variation suffixes and @functionName per-segment annotations from a path
     * string. Returns one SvgItemExtensions entry per command, parallel to parse() output.
     * Parse errors are silently swallowed; returns whatever was extracted up to the error.
     */
    public static extractCustomExtensions(path: string): SvgItemExtensions[] {
        const result: SvgItemExtensions[] = [];
        let cursor = 0;
        try {
            while (cursor < path.length) {
                const cmdMatch = path.slice(cursor).match(kCommandTypeRegex);
                if (!cmdMatch) break;
                let type = cmdMatch[1];
                cursor += cmdMatch[0].length;
                const expectedRegexList = kGrammar[type.toUpperCase()] || [];

                if (expectedRegexList.length === 0) {
                    // Z — no numeric args; just look for a trailing @annotation.
                    const am = path.slice(cursor).match(kAnnotationSingleRegex);
                    result.push({ deltas: [], annotation: am ? am[0].slice(1) : null });
                    if (am) cursor += am[0].length;
                    const ws = path.slice(cursor).match(kCommaWsp);
                    if (ws) cursor += ws[0].length;
                    continue;
                }

                // Read repeated argument groups until no more match.
                groupLoop: while (cursor <= path.length) {
                    const savedCursor = cursor;
                    const deltas: (number | null)[] = [];
                    for (const regex of expectedRegexList) {
                        const m = path.slice(cursor).match(regex);
                        if (!m) {
                            cursor = savedCursor;
                            break groupLoop;
                        }
                        cursor += m[0].length;
                        const dm = path.slice(cursor).match(kDeltaRegex);
                        deltas.push(dm ? parseFloat(dm[0].slice(1)) : null);
                        if (dm) cursor += dm[0].length;
                        const ws = path.slice(cursor).match(kCommaWsp);
                        if (ws) cursor += ws[0].length;
                    }
                    const am = path.slice(cursor).match(kAnnotationSingleRegex);
                    const annotation = am ? am[0].slice(1) : null;
                    if (am) {
                        cursor += am[0].length;
                        const ws = path.slice(cursor).match(kCommaWsp);
                        if (ws) cursor += ws[0].length;
                    }
                    result.push({ deltas, annotation });
                    if (type === 'M') type = 'L';
                    if (type === 'm') type = 'l';
                }
            }
        } catch (_) { /* swallow parse errors; return partial result */ }
        return result;
    }

    /** Strip ±delta variation suffixes and @functionName annotations before standard parsing. */
    public static stripCustomExtensions(path: string): string {
        return path.replace(kVariationRegex, '').replace(kAnnotationRegex, '');
    }

    public static parse(path: string): string[][] {
        path = PathParser.stripCustomExtensions(path);
        let cursor = 0;
        let tokens: string[][] = [];
        while (cursor < path.length) {
            const match = path.slice(cursor).match(kCommandTypeRegex);
            if (match !== null) {
                const command = match[1];
                if(cursor === 0 && command.toLowerCase() !== 'm') {
                    throw new Error('malformed path (first error at ' + cursor + ')');
                }
                cursor += match[0].length;
                const componentList = PathParser.components(command, path, cursor);
                cursor = componentList[0];
                tokens = [...tokens, ...componentList[1]];
            } else {
                throw new Error('malformed path (first error at ' + cursor + ')');
            }
        }
        return tokens;
    }
}
