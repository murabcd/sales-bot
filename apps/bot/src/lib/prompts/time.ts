export function formatUserDateTime(now: Date, timeZone: string) {
	const formatter = new Intl.DateTimeFormat("ru-RU", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
	const parts = formatter.formatToParts(now);
	const map = new Map(parts.map((part) => [part.type, part.value]));
	const year = map.get("year") ?? "";
	const month = map.get("month") ?? "";
	const day = map.get("day") ?? "";
	const hour = map.get("hour") ?? "";
	const minute = map.get("minute") ?? "";
	if (!year || !month || !day || !hour || !minute) {
		return `${now.toISOString().slice(0, 16)}Z`;
	}
	return `${year}-${month}-${day} ${hour}:${minute}`;
}
