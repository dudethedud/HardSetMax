import { describe, expect, it } from 'vitest';
import { channelWeight, countsVoiceMinute, minutesUnderCap, type VoiceMemberState } from './activityRules.js';
import { emptySpamState, evaluateMessage, isBotCommand, isFiltered, isSpamStateIdle, type MessageOutcome, type MessageRulesConfig, type SpamState } from './messageRules.js';
import { distinctAlnumCount, fingerprint, isEmojiOrStickerOnly, isOnlyMentionsLinksEmoji, normalize, similarity } from './messageText.js';
import { compareUserIds, computeScores, rankScores } from './scoring.js';

const cfg: MessageRulesConfig = {
  cooldownSec: 60,
  minLength: 4,
  repeatHistory: 5,
  repeatMinutes: 10,
  repeatSimilarity: 0.8,
  minDistinctChars: 3,
  burstCount: 8,
  burstSeconds: 30,
  burstMuteMinutes: 10,
};

const MIN = 60_000;

/** Sends messages in order; returns each outcome. Times are in ms. */
function send(messages: [text: string, at: number, hasStickers?: boolean][], c = cfg, start: SpamState = emptySpamState()) {
  let state = start;
  const outcomes: MessageOutcome[] = [];
  for (const [text, at, hasStickers = false] of messages) {
    const r = evaluateMessage(state, { text, at, hasStickers }, c);
    state = r.state;
    outcomes.push(r.outcome);
  }
  return { outcomes, state };
}

describe('message text', () => {
  it('normalizes to lowercase letters and digits', () => {
    expect(normalize('Hello, World! 123')).toBe('helloworld123');
    expect(normalize('Ça va? Ñandú')).toBe('çavañandú');
  });

  it('recognises emoji/sticker-only messages', () => {
    expect(isEmojiOrStickerOnly('😂😂 🔥', false)).toBe(true);
    expect(isEmojiOrStickerOnly('<:pepe:123456789012345678> <a:dance:123456789012345678>', false)).toBe(true);
    expect(isEmojiOrStickerOnly('👍🏽 🇨🇦 ❤️', false)).toBe(true);
    expect(isEmojiOrStickerOnly('', true)).toBe(true);
    expect(isEmojiOrStickerOnly('nice 😂', false)).toBe(false);
    expect(isEmojiOrStickerOnly('1234', false)).toBe(false);
    expect(isEmojiOrStickerOnly('', false)).toBe(false);
  });

  it('recognises mention/link-only messages', () => {
    expect(isOnlyMentionsLinksEmoji('<@123456789012345678> <#123456789012345678> https://example.com/x 🔥')).toBe(true);
    expect(isOnlyMentionsLinksEmoji('<@123456789012345678> look at this')).toBe(false);
  });

  it('counts distinct letters and digits', () => {
    expect(distinctAlnumCount('hhhhhh')).toBe(1);
    expect(distinctAlnumCount('hahahaha')).toBe(2);
    expect(distinctAlnumCount('aaaa!!!! bbb ccc')).toBe(3);
  });

  it('fingerprints identical text identically and different text differently', () => {
    expect(similarity(fingerprint('Good morning everyone!'), fingerprint('good morning, everyone'))).toBe(1);
    expect(similarity(fingerprint('good morning everyone'), fingerprint('good morning everyone!!! :)'))).toBe(1);
    expect(similarity(fingerprint('good morning everyone'), fingerprint('good mornin everyone'))).toBeGreaterThan(0.8);
    expect(similarity(fingerprint('good morning everyone'), fingerprint('what are you all playing'))).toBeLessThan(0.2);
  });

  it('keeps numbers, not text, in the fingerprint', () => {
    for (const x of fingerprint('secret message')) expect(typeof x).toBe('number');
  });
});

describe('evaluateMessage: basic rules', () => {
  it('counts a normal message, then applies the cooldown', () => {
    expect(send([['hello there', 0], ['what is up everyone', 30_000], ['ok back now', 61_000]]).outcomes).toEqual([
      'counted',
      'cooldown',
      'counted',
    ]);
  });

  it('the cooldown starts from the last counted message, not the last message', () => {
    const { outcomes } = send([['hello there', 0], ['what are we doing', 50_000], ['anything fun later', 65_000]]);
    expect(outcomes).toEqual(['counted', 'cooldown', 'counted']);
  });

  it('skips short and emoji/sticker-only messages without flagging them', () => {
    expect(send([['lol', 0], ['  ok  ', MIN], ['😂😂😂😂', 2 * MIN], ['', 3 * MIN, true], ['hi', 4 * MIN, true]]).outcomes).toEqual([
      'too-short',
      'too-short',
      'emoji-only',
      'emoji-only',
      'too-short',
    ]);
  });

  it('flags low effort messages', () => {
    const outcomes = send([['hhhhhh', 0], ['!!!!!!', MIN], ['<@123456789012345678> https://x.y', 2 * MIN], ['hahahaha', 3 * MIN]]).outcomes;
    expect(outcomes).toEqual(['filtered-low-effort', 'filtered-low-effort', 'filtered-low-effort', 'filtered-low-effort']);
    // "hahahaha" has only 2 distinct letters; with 3 required it's low effort. Lowering the
    // threshold lets it through:
    expect(send([['hahahaha', 0]], { ...cfg, minDistinctChars: 2 }).outcomes).toEqual(['counted']);
  });
});

describe('evaluateMessage: commands for other bots', () => {
  it("doesn't count !rank, ?help, .work or -play, and doesn't flag them as spam", () => {
    for (const cmd of ['!rank', '?help me', '.work', '-play never gonna', '$balance']) expect(isBotCommand(cmd)).toBe(true);
    expect(send([['!rank please', 0]]).outcomes).toEqual(['bot-command']);
    expect(isFiltered('bot-command')).toBe(false);
  });

  it('ordinary messages that start with punctuation still count', () => {
    for (const text of ['...anyway what now', '- bullet point', '! wow', '?? what', '> quoting someone']) expect(isBotCommand(text)).toBe(false);
    expect(send([['...anyway what now', 0]]).outcomes).toEqual(['counted']);
  });
});

describe('evaluateMessage: repeats', () => {
  it('flags the same or nearly the same message as one of the last 5', () => {
    const { outcomes } = send([
      ['anyone want to play?', 0],
      ['Anyone want to play', 2 * MIN],
      ['anyone want to play??? :)', 4 * MIN],
      ['anyone wanna play', 6 * MIN],
    ]);
    expect(outcomes.slice(0, 3)).toEqual(['counted', 'filtered-repeat', 'filtered-repeat']);
    expect(outcomes[3]).toBe('counted'); // different enough
  });

  it('forgets messages after the repeat window', () => {
    expect(send([['anyone want to play?', 0], ['anyone want to play?', 11 * MIN]]).outcomes).toEqual(['counted', 'counted']);
  });

  it('only compares to the last 5 messages', () => {
    const msgs: [string, number][] = [['the original message', 0]];
    const others = ['second thing here', 'third topic now', 'fourth idea maybe', 'fifth question why', 'sixth remark okay'];
    others.forEach((t, i) => msgs.push([t, (i + 1) * MIN]));
    msgs.push(['the original message', 7 * MIN]);
    expect(send(msgs).outcomes.at(-1)).toBe('counted');
  });

  it('uses the configured similarity', () => {
    const msgs: [string, number][] = [['good morning everyone', 0], ['good mornin everyone', 2 * MIN]];
    expect(send(msgs).outcomes[1]).toBe('filtered-repeat');
    expect(send(msgs, { ...cfg, repeatSimilarity: 1 }).outcomes[1]).toBe('counted');
  });
});

const DIFFERENT = [
  'did anyone see the game',
  'pizza tonight sounds good',
  'my cat knocked over a plant',
  'homework is due friday',
  'new song just dropped',
  'who is online later',
  'that movie was wild',
  'brb grabbing food',
];

describe('evaluateMessage: bursts', () => {
  it('8 messages in 30 s mutes counting for 10 minutes', () => {
    const msgs: [string, number][] = DIFFERENT.map((t, i) => [t, i * 2000]);
    const { outcomes, state } = send(msgs);
    expect(outcomes[0]).toBe('counted');
    expect(outcomes.slice(1, 7).every((o) => o === 'cooldown')).toBe(true);
    expect(outcomes[7]).toBe('filtered-burst');

    // Still muted 9 minutes later, counting again after 10.
    expect(send([['a fresh new message', 14_000 + 9 * MIN]], cfg, state).outcomes).toEqual(['filtered-burst']);
    expect(send([['a fresh new message', 14_000 + 10 * MIN]], cfg, state).outcomes).toEqual(['counted']);
  });

  it('short messages count toward a burst', () => {
    const msgs: [string, number][] = Array.from({ length: 8 }, (_, i) => ['lol', i * 1000]);
    expect(send(msgs).outcomes.at(-1)).toBe('filtered-burst');
  });

  it('7 messages in 30 s is fine', () => {
    const msgs: [string, number][] = DIFFERENT.slice(0, 7).map((t, i) => [t, i * 4000]);
    expect(send(msgs).outcomes.some((o) => o === 'filtered-burst')).toBe(false);
  });
});

describe('spam state housekeeping', () => {
  it('is idle once nothing in it can matter', () => {
    const { state } = send([['hello there', 0]]);
    expect(isSpamStateIdle(state, 30_000, cfg)).toBe(false);
    expect(isSpamStateIdle(state, 10 * MIN + 1, cfg)).toBe(true);
    expect(isSpamStateIdle(emptySpamState(), 0, cfg)).toBe(true);
  });

  it('isFiltered only for spam outcomes', () => {
    expect(isFiltered('filtered-repeat')).toBe(true);
    expect(isFiltered('cooldown')).toBe(false);
    expect(isFiltered('too-short')).toBe(false);
  });
});

describe('channel weights', () => {
  const weights = new Map([
    ['memes', 0.5],
    ['botspam', 0],
  ]);

  it('uses the channel weight, default 1', () => {
    expect(channelWeight({ id: 'memes', parentId: 'cat', isThread: false }, weights)).toBe(0.5);
    expect(channelWeight({ id: 'general', parentId: 'cat', isThread: false }, weights)).toBe(1);
  });

  it("threads and forum posts use their parent's weight", () => {
    expect(channelWeight({ id: 'thread1', parentId: 'botspam', isThread: true }, weights)).toBe(0);
    expect(channelWeight({ id: 'thread2', parentId: 'memes', isThread: true }, new Map([...weights, ['thread2', 1]]))).toBe(0.5);
  });

  it("a channel's category weight doesn't apply to it", () => {
    expect(channelWeight({ id: 'general', parentId: 'memes', isThread: false }, weights)).toBe(1);
  });
});

describe('voice minutes', () => {
  const m = (over: Partial<VoiceMemberState> = {}): VoiceMemberState => ({
    isBot: false,
    channelId: 'vc',
    selfDeaf: false,
    serverDeaf: false,
    ...over,
  });

  it('counts with at least one other non-bot member', () => {
    expect(countsVoiceMinute(m(), [m()], 'afk')).toBe(true);
    expect(countsVoiceMinute(m(), [m({ selfDeaf: true })], 'afk')).toBe(true); // others may be deafened
  });

  it("doesn't count alone, with only bots, in another channel, AFK, or deafened", () => {
    expect(countsVoiceMinute(m(), [], 'afk')).toBe(false);
    expect(countsVoiceMinute(m(), [m({ isBot: true })], 'afk')).toBe(false);
    expect(countsVoiceMinute(m(), [m({ channelId: 'other' })], 'afk')).toBe(false);
    expect(countsVoiceMinute(m({ channelId: 'afk' }), [m({ channelId: 'afk' })], 'afk')).toBe(false);
    expect(countsVoiceMinute(m({ selfDeaf: true }), [m()], 'afk')).toBe(false);
    expect(countsVoiceMinute(m({ serverDeaf: true }), [m()], 'afk')).toBe(false);
    expect(countsVoiceMinute(m({ isBot: true }), [m()], 'afk')).toBe(false);
  });

  it('caps daily minutes', () => {
    expect(minutesUnderCap(0, 1, 240)).toBe(1);
    expect(minutesUnderCap(239, 1, 240)).toBe(1);
    expect(minutesUnderCap(240, 1, 240)).toBe(0);
    expect(minutesUnderCap(250, 1, 240)).toBe(0);
  });
});

describe('scoring', () => {
  const window = ['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'];
  const A = '200000000000000001';
  const B = '100000000000000002';
  const C = '300000000000000003';

  it('sums weighted messages and weighted voice minutes in the window', () => {
    const scores = computeScores(
      [
        { userId: A, serverDay: '2026-10-16', weightedMessages: 10, voiceMinutes: 50 },
        { userId: A, serverDay: '2026-10-22', weightedMessages: 5.5, voiceMinutes: 0 },
        { userId: A, serverDay: '2026-10-15', weightedMessages: 100, voiceMinutes: 0 }, // outside
        { userId: A, serverDay: '2026-10-23', weightedMessages: 100, voiceMinutes: 0 }, // today, outside
      ],
      [],
      window,
      0.2,
    );
    expect(scores.get(A)).toEqual({ userId: A, score: 25.5, activeDays: 2, lastDayScore: 5.5 });
  });

  it('includes adjustments in the window, without making a day active', () => {
    const scores = computeScores([], [{ userId: A, serverDay: '2026-10-20', amount: -3 }, { userId: A, serverDay: '2026-10-01', amount: 50 }], window, 0.2);
    expect(scores.get(A)).toEqual({ userId: A, score: -3, activeDays: 0, lastDayScore: 0 });
  });

  it('a day with only filtered messages is not active', () => {
    const scores = computeScores([{ userId: A, serverDay: '2026-10-20', weightedMessages: 0, voiceMinutes: 0 }], [], window, 0.2);
    expect(scores.get(A)?.activeDays).toBe(0);
  });

  it('ranks by score, then active days, then last-day score, then smaller user ID', () => {
    const ranked = rankScores([
      { userId: A, score: 10, activeDays: 2, lastDayScore: 0 },
      { userId: B, score: 10, activeDays: 2, lastDayScore: 0 },
      { userId: C, score: 10, activeDays: 3, lastDayScore: 0 },
      { userId: '400000000000000004', score: 10, activeDays: 2, lastDayScore: 1 },
      { userId: '500000000000000005', score: 11, activeDays: 1, lastDayScore: 0 },
    ]);
    expect(ranked.map((s) => s.userId)).toEqual(['500000000000000005', C, '400000000000000004', B, A]);
  });

  it('compares user IDs as numbers, not text', () => {
    expect(compareUserIds('99999999999999999', '100000000000000000')).toBe(-1);
  });
});
