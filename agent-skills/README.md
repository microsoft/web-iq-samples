# WebIQ Auto agent skills

Version 1.3 — guidance update; skill instructions unchanged.

Short instruction skills for agents that use the **WebIQ Auto** search tool. A skill is a block of
plain text that you add to your agent's instructions. It changes how the agent searches and when
it stops; it does not change Auto itself.

| Skill | Choose it when | What to expect |
|---|---|---|
| [`webiq-auto-efficiency`](webiq-auto-efficiency/SKILL.md) | Opt-in for token-sensitive workloads after validation | Roughly 20–40% fewer agent tokens in our tested configurations; quality trade-offs can be larger on difficult requests |

This is an optional trade-off, not a replacement default or a claim that the skill improves answer
quality. If completeness matters more than token usage, retain your agent's existing research
configuration without adding this skill.

**Quality preservation is not established.** Token savings alone are not evidence that an answer
retains all necessary facts or reaches the correct conclusion.

**Tokens are not total cost.** The skill can reduce the tokens your model reads and writes. It does
not reduce the price per search, and on some models it can lead the agent to make more search calls,
which can offset the token saving. Measure total cost, including search charges, on the model you
deploy. Lower latency has not been established.

Existing installations do not need a new instruction body for this guidance update. This
README explains the scope and limitations; changing the instructions would create a new variant.

## Install

- **Agents that load skill folders** (for example, agents that read `SKILL.md` files): copy the
  skill folder into the agent's skills directory.
- **Any other agent:** append the skill body to the end of your existing system prompt; do not
  replace your existing instructions. The body is everything after the closing `---` of the front
  matter. Different placement or automatic activation should be evaluated separately.

Use the body as written. It is the exact text we evaluated. Edits, translations or merges with
other search guidance create a new variant that you should evaluate yourself.

## Integration requirements

1. **The search tool must be WebIQ Auto.** The skill relies on Auto's behaviour: it plans its own
   retrieval from a natural-language request and returns extracted passages.
2. **Allow parallel tool calls.** The skill requests independent searches together. If your agent
   serializes them, validate that execution pattern rather than assuming identical behavior.
3. **Expose `maxResults` and `maxLength`** on your Auto tool, and trim the returned results to the
   requested count and length in your tool wrapper before they reach the model. Most of the token
   saving comes from this trimming.

## Test in your setup

We evaluated English, enterprise-like research requests using existing agent instructions, bounded
search calls and response-size controls. This does not establish performance across every integration
or customer workload. "Without the skill" means the same agent with its existing instructions and
settings, not an uninstructed agent.

Before adopting it, compare your current agent with and without the skill on representative requests,
including difficult cases. Keep the model, existing instructions, tools and limits fixed. Track answer
quality, serious omissions, agent tokens, search calls, total cost and unverified-answer rates.
Models, instruction placement and tool settings can materially change the result.

## Guidance that applies with or without a skill

- Send Auto complete natural-language requests rather than keyword strings.
- Send independent searches in parallel.
- If you expose `maxResults` and `maxLength`, enforce them in your tool wrapper.
