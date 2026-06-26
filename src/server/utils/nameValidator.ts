import {
	RegExpMatcher,
	englishDataset,
	englishRecommendedTransformers,
} from "obscenity";

const matcher = new RegExpMatcher({
	...englishDataset.build(),
	...englishRecommendedTransformers,
});

const RESERVED_NAMES = [
	"admin",
	"administrator",
	"mod",
	"staff",
	"system",
	"server",
	"owner",
	"developer",
];

export type NameValidationResult =
	| {
			ok: true;
			name: string;
	  }
	| {
			ok: false;
			reason: string;
	  };

export function validatePlayerName(input: unknown): NameValidationResult {
	if (typeof input !== "string") {
		return {
			ok: false,
			reason: "Name is required.",
		};
	}

	const name = normaliseName(input);

	if (name.length === 0) {
		return {
			ok: false,
			reason: "Name is required.",
		};
	}

	if (name.length < 3) {
		return {
			ok: false,
			reason: "Name must be at least 3 characters.",
		};
	}

	if (name.length > 20) {
		return {
			ok: false,
			reason: "Name must be 20 characters or fewer.",
		};
	}

	if (!hasAllowedCharacters(name)) {
		return {
			ok: false,
			reason: "Name can only contain letters, numbers, spaces, underscores, or hyphens.",
		};
	}

	if (hasReservedName(name)) {
		return {
			ok: false,
			reason: "Please choose a different name.",
		};
	}

	if (matcher.hasMatch(name)) {
		return {
			ok: false,
			reason: "Please choose a different name.",
		};
	}

	return {
		ok: true,
		name,
	};
}

function normaliseName(name: string): string {
	return name.trim().normalize("NFKC");
}

function hasAllowedCharacters(name: string): boolean {
	return /^[\p{L}\p{N}_\- ]+$/u.test(name);
}

function hasReservedName(name: string): boolean {
	const tokens = name.toLowerCase().split(/[\s_-]+/).filter(Boolean);
	return tokens.some((token) => RESERVED_NAMES.includes(token));
}
