export type CandidateIssue = {
	key: string | null;
	summary: string;
	score: number;
};

export type ChatState = {
	lastCandidates: CandidateIssue[];
	lastPrimaryKey: string | null;
	lastUpdatedAt: number;
};

const chatStates = new Map<string, ChatState>();

export function getChatState(chatId: string): ChatState {
	const existing = chatStates.get(chatId);
	if (existing) return existing;
	const fresh: ChatState = {
		lastCandidates: [],
		lastPrimaryKey: null,
		lastUpdatedAt: 0,
	};
	chatStates.set(chatId, fresh);
	return fresh;
}
