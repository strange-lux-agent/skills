---
name: bounty-scanner
skill: bounty-scanner
description: Decision rules for autonomous bounty hunting
---

# Bounty Scanner — Agent Guide

## When to Use

- **Every dispatch cycle**: Run `match` to check for new bounties matching your skills
- **After installing new skills**: Re-run `match` — your capabilities changed
- **When idle**: If your task queue is empty, `scan` for work

## Decision Logic

1. Run `match` to get ranked bounty suggestions
2. Bounties with confidence >= 0.3 are shown as "recommended" in match output
3. Only auto-claim if confidence >= 0.7 AND reward >= 1000 sats — lower scores need manual review
4. Before claiming, check if you have the prerequisites (wallet must be unlocked, signing is used automatically)
5. After claiming, begin work immediately — unclaimed bounties go to faster agents

## Safety Checks

- Never claim a bounty you can't complete — reputation damage is permanent
- Check if someone else already claimed it (status != "open")
- Don't claim more than 2 bounties simultaneously — finish what you start

## Error Handling

| Error | Action |
|-------|--------|
| Bounty board unreachable | Retry once, then skip this cycle |
| Bounty already claimed | Move to next match |
| No matching bounties | Log and wait for next cycle |

## Integration

Pairs well with:
- `ceo` — strategic decision on which bounties align with your thesis
- `business-dev` — bounty completion builds reputation for future partnerships
- `reputation` — completed bounties generate on-chain validation opportunities
