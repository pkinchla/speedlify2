import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { throttleWait, hostOf } from "../lib/runner.js";

/**
 * Pacing rules for measuring other people's servers. Pure, so these run
 * instantly and without launching a browser.
 */

const NOW = 1_000_000;
const limit = { delayMs: 3000, hostCooldownMs: 60000 };

describe("throttleWait", () => {
	test("no rate limit means no wait", () => {
		assert.equal(throttleWait({ rateLimit: null, now: NOW, lastFinishedAt: NOW - 1 }), 0);
	});

	test("the first site is never delayed", () => {
		assert.equal(throttleWait({ rateLimit: limit, host: "a.example", now: NOW, lastFinishedAt: null }), 0);
	});

	test("waits out the remainder of the between-site delay", () => {
		// 1s since the last measurement finished, 3s required.
		const wait = throttleWait({ rateLimit: limit, host: "a.example", now: NOW, lastFinishedAt: NOW - 1000 });
		assert.equal(wait, 2000);
	});

	test("no wait once the delay has already elapsed", () => {
		const wait = throttleWait({ rateLimit: limit, host: "a.example", now: NOW, lastFinishedAt: NOW - 5000 });
		assert.equal(wait, 0);
	});

	test("holds off a host that was touched recently", () => {
		// Between-site delay satisfied, but this host was hit 10s ago.
		const lastHostAt = new Map([["a.example", NOW - 10000]]);
		const wait = throttleWait({
			rateLimit: limit,
			host: "a.example",
			now: NOW,
			lastFinishedAt: NOW - 5000,
			lastHostAt,
		});
		assert.equal(wait, 50000, "the host cooldown still has 50s to run");
	});

	test("a different host is unaffected by another host's cooldown", () => {
		const lastHostAt = new Map([["a.example", NOW - 10]]);
		const wait = throttleWait({
			rateLimit: limit,
			host: "b.example",
			now: NOW,
			lastFinishedAt: NOW - 5000,
			lastHostAt,
		});
		assert.equal(wait, 0);
	});

	test("the longer of the two limits wins", () => {
		const lastHostAt = new Map([["a.example", NOW - 59000]]);
		// Between-site delay wants 2000ms; host cooldown wants 1000ms.
		const wait = throttleWait({
			rateLimit: limit,
			host: "a.example",
			now: NOW,
			lastFinishedAt: NOW - 1000,
			lastHostAt,
		});
		assert.equal(wait, 2000);
	});

	test("never returns a negative wait", () => {
		const wait = throttleWait({
			rateLimit: limit,
			host: "a.example",
			now: NOW,
			lastFinishedAt: NOW - 999999,
			lastHostAt: new Map([["a.example", NOW - 999999]]),
		});
		assert.equal(wait, 0);
	});

	test("either limit can be configured alone", () => {
		const delayOnly = throttleWait({
			rateLimit: { delayMs: 3000 },
			host: "a.example",
			now: NOW,
			lastFinishedAt: NOW - 1000,
			lastHostAt: new Map([["a.example", NOW - 1]]),
		});
		assert.equal(delayOnly, 2000, "host cooldown is off, so only the delay applies");

		const hostOnly = throttleWait({
			rateLimit: { hostCooldownMs: 60000 },
			host: "a.example",
			now: NOW,
			lastFinishedAt: NOW - 1,
			lastHostAt: new Map([["a.example", NOW - 30000]]),
		});
		assert.equal(hostOnly, 30000, "delay is off, so only the cooldown applies");
	});

	test("an unparseable URL still respects the between-site delay", () => {
		const wait = throttleWait({ rateLimit: limit, host: null, now: NOW, lastFinishedAt: NOW - 1000 });
		assert.equal(wait, 2000);
	});
});

describe("hostOf", () => {
	test("extracts the hostname", () => {
		assert.equal(hostOf("https://example.com/some/path"), "example.com");
		assert.equal(hostOf("http://sub.example.com:8080/"), "sub.example.com");
	});

	test("returns null rather than throwing on junk", () => {
		assert.equal(hostOf("not a url"), null);
		assert.equal(hostOf(undefined), null);
	});
});
