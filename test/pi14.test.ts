import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { StorageRequestError, type ConversationId, type DocumentId, type EntryId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { freshStorage } from "./helpers.js";

// Pi 1.4 distinguishes invalid reads from storage failures that close a Harness.
describe("Pi 1.4 read errors", () => {
	it.each([
		[{ order: "invalid" }, undefined],
		[{}, {}],
		[{}, { after: 1.5 }],
		[{}, { after: Number.MAX_SAFE_INTEGER + 1 }],
		[{}, { after: 2, order: "invalid" }],
		[{ order: "descending" }, { after: 2, order: "ascending" }],
		[{ order: "descending" }, { after: 2 }],
	] as const)("rejects invalid conversation/task/submission scans (%j, %j)", async (query, cursor) => {
		const fixture = await freshStorage();
		try {
			for (const scan of ["scanConversations", "scanTasks", "scanSubmissions"] as const) {
				await expect(fixture.storage[scan](query as never, 10, cursor as never, context))
					.rejects.toBeInstanceOf(StorageRequestError);
			}
			await expect(fixture.storage.scanConversations({}, 10, undefined, context))
				.resolves.toMatchObject({ items: [] });
		} finally { await fixture.cleanup(); }
	});

	it("reports unknown conversation reads as request errors without losing storage", async () => {
		const fixture = await freshStorage();
		try {
			const conversation = await fixture.storage.mintId<ConversationId>();
			const entry = await fixture.storage.mintId<EntryId>();
			await expect(fixture.storage.scanEntries({ conversationId: conversation }, 10, undefined, context))
				.rejects.toBeInstanceOf(StorageRequestError);
			await expect(fixture.storage.entry(conversation, entry, context))
				.rejects.toBeInstanceOf(StorageRequestError);
			await expect(fixture.storage.findLatestHeadMarker(conversation, undefined, context))
				.rejects.toBeInstanceOf(StorageRequestError);
			await fixture.storage.commit([{ type: "conversation", value: { id: conversation } }], context);
			await expect(fixture.storage.conversation(conversation, context)).resolves.toMatchObject({ id: conversation });
		} finally { await fixture.cleanup(); }
	});
});

// A rejected copy is a failed commit, never a recoverable read request.
it("rolls back a copy from a current-only document's historical point", async () => {
	const fixture = await freshStorage();
	try {
		const conversation = await fixture.storage.mintId<ConversationId>();
		const source = await fixture.storage.mintId<DocumentId>();
		const copy = await fixture.storage.mintId<DocumentId>();
		const record = { kind: "test", scope: { kind: "conversation" as const, conversationId: conversation }, history: "latest" as const, fork: "initial" as const };
		const at = await fixture.storage.commit([
			{ type: "conversation", value: { id: conversation } },
			{ type: "document.create", record: { ...record, id: source }, content: { kind: "base", version: 1, value: {} } },
		], context);
		const failure = await fixture.storage.commit([
			{ type: "document.copy", record: { ...record, id: copy }, source: { id: source, at } },
		], context).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		expect(failure).not.toBeInstanceOf(StorageRequestError);
		await expect(fixture.storage.document(copy, "current", context)).resolves.toBeUndefined();
		expect((await fixture.storage.document(source, "current", context))?.value).toEqual({});
	} finally { await fixture.cleanup(); }
});
