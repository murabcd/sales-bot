export function tokenize(text: string): string[] {
	const tokens: string[] = [];
	let current = "";
	for (const ch of text) {
		if (isTokenChar(ch)) {
			current += ch;
		} else if (current) {
			tokens.push(current);
			current = "";
		}
	}
	if (current) tokens.push(current);
	return tokens;
}

export function isTokenChar(ch: string): boolean {
	return (
		isLetterChar(ch) ||
		isDigitChar(ch) ||
		ch === "." ||
		ch === "_" ||
		ch === "-"
	);
}

export function isDigitChar(ch: string): boolean {
	const code = ch.codePointAt(0);
	if (code === undefined) return false;
	return code >= 48 && code <= 57;
}

export function isLetterChar(ch: string): boolean {
	const code = ch.codePointAt(0);
	if (code === undefined) return false;
	return (
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122) ||
		(code >= 0x0400 && code <= 0x052f)
	);
}

export function isAllDigits(value: string): boolean {
	if (!value) return false;
	for (const ch of value) {
		if (!isDigitChar(ch)) return false;
	}
	return true;
}

export function isAllLettersOrDigits(value: string): boolean {
	if (!value) return false;
	for (const ch of value) {
		if (!isLetterChar(ch) && !isDigitChar(ch)) return false;
	}
	return true;
}

export function transliterateCyrillicToLatin(value: string): string {
	const map: Record<string, string> = {
		а: "a",
		б: "b",
		в: "v",
		г: "g",
		д: "d",
		е: "e",
		ё: "yo",
		ж: "zh",
		з: "z",
		и: "i",
		й: "y",
		к: "k",
		л: "l",
		м: "m",
		н: "n",
		о: "o",
		п: "p",
		р: "r",
		с: "s",
		т: "t",
		у: "u",
		ф: "f",
		х: "kh",
		ц: "ts",
		ч: "ch",
		ш: "sh",
		щ: "shch",
		ъ: "",
		ы: "y",
		ь: "",
		э: "e",
		ю: "yu",
		я: "ya",
	};
	let out = "";
	for (const ch of value) {
		const lower = ch.toLowerCase();
		const mapped = map[lower];
		out += mapped !== undefined ? mapped : lower;
	}
	return out;
}

export function transliterateLatinToCyrillic(value: string): string {
	const pairs: Array<[string, string]> = [
		["shch", "щ"],
		["yo", "ё"],
		["zh", "ж"],
		["kh", "х"],
		["ts", "ц"],
		["ch", "ч"],
		["sh", "ш"],
		["yu", "ю"],
		["ya", "я"],
		["ye", "е"],
	];
	const single: Record<string, string> = {
		a: "а",
		b: "б",
		v: "в",
		g: "г",
		d: "д",
		e: "е",
		z: "з",
		i: "и",
		y: "й",
		k: "к",
		l: "л",
		m: "м",
		n: "н",
		o: "о",
		p: "п",
		r: "р",
		s: "с",
		t: "т",
		u: "у",
		f: "ф",
		h: "х",
		c: "к",
	};
	const lower = value.toLowerCase();
	let out = "";
	let i = 0;
	while (i < lower.length) {
		let matched = false;
		for (const [latin, cyr] of pairs) {
			if (lower.startsWith(latin, i)) {
				out += cyr;
				i += latin.length;
				matched = true;
				break;
			}
		}
		if (matched) continue;
		const ch = lower[i];
		out += single[ch] ?? ch;
		i += 1;
	}
	return out;
}

export function normalizeForMatch(value: string): string {
	return transliterateCyrillicToLatin(value.toLowerCase());
}

export function expandTermVariants(term: string): string[] {
	const normalized = term.trim();
	if (!normalized) return [];
	const latin = transliterateCyrillicToLatin(normalized);
	const cyrillic = transliterateLatinToCyrillic(normalized);
	const unique = new Set([normalized, latin, cyrillic]);
	return Array.from(unique).filter((item) => item.length > 0);
}

export function extractKeywords(text: string, limit = 6): string[] {
	const tokens = tokenize(text).filter((token) => token.length >= 3);
	const unique = Array.from(new Set(tokens.map((token) => token.trim())));
	return unique.slice(0, limit);
}

export function extractIssueKeysFromText(
	text: string,
	defaultPrefix: string,
): string[] {
	const keys: string[] = [];
	const seen = new Set<string>();
	const trimmed = text.trim();
	if (trimmed.length >= 3 && trimmed.length <= 6 && isAllDigits(trimmed)) {
		const key = `${defaultPrefix}-${trimmed}`;
		if (!seen.has(key)) {
			seen.add(key);
			keys.push(key);
		}
	}
	const tokens = tokenize(text);
	for (const token of tokens) {
		if (token.length >= 3 && token.length <= 6 && isAllDigits(token)) {
			const key = `${defaultPrefix}-${token}`;
			if (!seen.has(key)) {
				seen.add(key);
				keys.push(key);
			}
		}
	}
	for (const token of tokens) {
		const dashIndex = token.indexOf("-");
		if (dashIndex <= 0 || dashIndex >= token.length - 1) continue;
		const prefix = token.slice(0, dashIndex);
		const suffix = token.slice(dashIndex + 1);
		if (!prefix || !suffix) continue;
		if (!isLetterChar(prefix[0])) continue;
		if (!isAllLettersOrDigits(prefix)) continue;
		if (!isAllDigits(suffix)) continue;
		const key = `${prefix.toUpperCase()}-${suffix}`;
		if (!seen.has(key)) {
			seen.add(key);
			keys.push(key);
		}
	}

	return keys;
}

export function truncateText(input: string, limit: number): string {
	if (input.length <= limit) return input;
	return `${input.slice(0, limit)}…`;
}
