#!/usr/bin/env bun
/**
 * Bounty Scanner skill CLI
 * Autonomous bounty hunting — scan, match, claim, and track bounties
 *
 * Usage: bun run bounty-scanner/bounty-scanner.ts <subcommand> [options]
 */

import { Command } from "commander";
import { printJson, handleError } from "../src/lib/utils/cli.js";
import { getWalletManager } from "../src/lib/services/wallet-manager.js";
import { signMessageHashRsv } from "@stacks/transactions";
import { hashMessage } from "@stacks/encryption";
import { bytesToHex } from "@stacks/common";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const BOUNTY_API =
  process.env.BOUNTY_API_URL ?? "https://1btc-news-api.p-d07.workers.dev";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Bounty {
  id: string;
  title: string;
  description?: string;
  reward: number;
  status: string;
  claimer?: string;
  poster?: string;
  created_at: number;
}

interface SkillInfo {
  name: string;
  description: string;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchBounties(): Promise<Bounty[]> {
  const res = await fetch(`${BOUNTY_API}/bounties`);
  if (!res.ok) throw new Error(`Bounty API returned ${res.status}`);
  const data = (await res.json()) as { bounties?: Bounty[] };
  return data.bounties ?? [];
}

function getStxAddress(address?: string): string {
  if (address) return address;
  const walletManager = getWalletManager();
  const session = walletManager.getSessionInfo();
  if (session?.stxAddress) return session.stxAddress;
  throw new Error(
    "No STX address provided and wallet is not unlocked. " +
      "Either provide --address or unlock your wallet first."
  );
}

/**
 * Get the active wallet account or throw a consistent error.
 */
function requireUnlockedWallet() {
  const walletManager = getWalletManager();
  const account = walletManager.getActiveAccount();
  if (!account) {
    throw new Error(
      "Wallet is not unlocked. Use wallet/wallet.ts unlock first."
    );
  }
  return account;
}

/**
 * Sign a claim message proving control of the STX address.
 * Uses the Stacks message signing format (same as signing skill's stacks-sign).
 * Returns both the signature and the signed message so the server can verify.
 *
 * NOTE: The upstream bounty API at bounty.drx4.xyz uses BIP-322/BIP-137 BTC
 * signatures with format: "agent-bounties | claim-bounty | {btc_address} |
 * bounties/{uuid} | {timestamp}". This skill currently uses Stacks message
 * signing against a different API. Full alignment is tracked upstream.
 */
function signClaimMessage(
  bountyId: string,
  stxAddress: string,
  privateKey: string
): { signature: string; message: string; timestamp: string } {
  const timestamp = new Date().toISOString();
  const message = `claim:${bountyId}:${stxAddress}:${timestamp}`;
  const msgHash = hashMessage(message);
  const msgHashHex = bytesToHex(msgHash);
  const signature = signMessageHashRsv({
    messageHash: msgHashHex,
    privateKey,
  });
  return { signature, message, timestamp };
}

/**
 * Parse a bracket-list value like "[]" or "[wallet]" or "[l2, defi, write]".
 * Matches the logic in scripts/generate-manifest.ts.
 */
function parseBracketList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return trimmed.length > 0 ? [trimmed] : [];
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Matches the parsing logic in scripts/generate-manifest.ts.
 */
function parseFrontmatter(content: string): SkillInfo | null {
  const lines = content.split("\n");
  let inFrontmatter = false;
  const frontmatterLines: string[] = [];

  for (const line of lines) {
    if (line.trim() === "---") {
      if (!inFrontmatter) {
        inFrontmatter = true;
        continue;
      } else {
        break;
      }
    }
    if (inFrontmatter) {
      frontmatterLines.push(line);
    }
  }

  const fields: Record<string, string> = {};
  for (const line of frontmatterLines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fields[key] = value;
  }

  if (!fields.name) return null;

  return {
    name: fields.name,
    description: fields.description ?? "",
    tags: parseBracketList(fields.tags ?? "[]"),
  };
}

/**
 * Load installed skill names and descriptions.
 * First tries skills.json manifest, then falls back to scanning SKILL.md files.
 */
function getInstalledSkills(): SkillInfo[] {
  const repoRoot = join(import.meta.dir, "..");

  // Try skills.json first (faster)
  const manifestPath = join(repoRoot, "skills.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      const skills: SkillInfo[] = [];
      for (const skill of manifest.skills ?? []) {
        skills.push({
          name: skill.name ?? "",
          description: skill.description ?? "",
          tags: skill.tags ?? [],
        });
      }
      if (skills.length > 0) return skills;
    } catch {
      // fall through to directory scan
    }
  }

  // Directory scan fallback: find all */SKILL.md files
  const skills: SkillInfo[] = [];
  try {
    const entries = readdirSync(repoRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Skip non-skill directories
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.name === "src" ||
        entry.name === "scripts" ||
        entry.name === "dist"
      ) {
        continue;
      }
      const skillMdPath = join(repoRoot, entry.name, "SKILL.md");
      if (existsSync(skillMdPath)) {
        try {
          const content = readFileSync(skillMdPath, "utf-8");
          const info = parseFrontmatter(content);
          if (info) skills.push(info);
        } catch {
          // skip unreadable files
        }
      }
    }
  } catch {
    // repo root unreadable — return empty
  }

  return skills;
}

/**
 * Score how well a bounty matches the agent's installed skills.
 * Returns 0-1 confidence score.
 */
function scoreBountyMatch(
  bounty: { title: string; description: string },
  skills: SkillInfo[]
): { score: number; matchedSkills: string[]; reason: string } {
  const bountyText = `${bounty.title} ${bounty.description}`.toLowerCase();
  const matchedSkills: string[] = [];
  let score = 0;

  // Keyword matching against skill names and descriptions
  for (const skill of skills) {
    const skillWords =
      `${skill.name} ${skill.description} ${skill.tags.join(" ")}`.toLowerCase();
    const skillTokens = skillWords
      .split(/[\s\-_,./]+/)
      .filter((t) => t.length > 2);

    let hits = 0;
    for (const token of skillTokens) {
      if (bountyText.includes(token)) hits++;
    }

    if (hits >= 2) {
      matchedSkills.push(skill.name);
      score += Math.min(hits * 0.15, 0.5);
    }
  }

  // Bonus for wallet/signing only when bounty mentions payment or signing
  const mentionsPayment = /pay|transfer|send|sats|btc|stx|sbtc|escrow|fund/i.test(bountyText);
  const mentionsSigning = /sign|signature|verify|auth/i.test(bountyText);
  if (mentionsPayment && skills.some((s) => s.name === "wallet")) score += 0.1;
  if (mentionsSigning && skills.some((s) => s.name === "signing")) score += 0.1;

  // Cap at 1.0
  score = Math.min(score, 1.0);

  const reason =
    matchedSkills.length > 0
      ? `Matches skills: ${matchedSkills.join(", ")}`
      : "No direct skill match — may require new capabilities";

  return { score: Math.round(score * 100) / 100, matchedSkills, reason };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command()
  .name("bounty-scanner")
  .description(
    "Autonomous bounty hunting — scan, match, claim, and track bounties"
  );

// -- scan -------------------------------------------------------------------
program
  .command("scan")
  .description("List all open bounties with rewards")
  .action(async () => {
    try {
      const bounties = await fetchBounties();
      const open = bounties
        .filter((b) => b.status === "open")
        .map((b) => ({
          id: b.id,
          title: b.title,
          reward: b.reward,
          posted: b.created_at,
        }));

      printJson({
        success: true,
        openBounties: open.length,
        bounties: open,
      });
    } catch (err) {
      handleError(err);
    }
  });

// -- match ------------------------------------------------------------------
program
  .command("match")
  .description("Match open bounties to your installed skills")
  .action(async () => {
    try {
      const bounties = await fetchBounties();
      const skills = getInstalledSkills();
      const open = bounties.filter((b) => b.status === "open");

      const matches = open
        .map((b) => {
          const match = scoreBountyMatch(
            { title: b.title, description: b.description ?? "" },
            skills
          );
          return {
            id: b.id,
            title: b.title,
            reward: b.reward,
            confidence: match.score,
            matchedSkills: match.matchedSkills,
            reason: match.reason,
          };
        })
        .sort((a, b) => b.confidence - a.confidence);

      // Display threshold: 0.3 for showing recommendations
      // Agent auto-claim threshold: 0.7 (see AGENT.md decision logic)
      const recommended = matches.filter((m) => m.confidence >= 0.3);

      printJson({
        success: true,
        installedSkills: skills.length,
        openBounties: open.length,
        recommendedBounties: recommended.length,
        matches: matches.slice(0, 10),
        note: "Display threshold: 0.3 (recommended). Auto-claim threshold: 0.7 (see AGENT.md).",
        action:
          recommended.length > 0
            ? `Top match: "${recommended[0].title}" (${recommended[0].confidence * 100}% confidence, ${recommended[0].reward} sats)`
            : "No strong matches found. Install more skills or check back later.",
      });
    } catch (err) {
      handleError(err);
    }
  });

// -- claim ------------------------------------------------------------------
program
  .command("claim")
  .argument("<bounty-id>", "Bounty ID to claim")
  .description("Claim a bounty for your agent (requires unlocked wallet)")
  .action(async (bountyId: string) => {
    try {
      const account = requireUnlockedWallet();
      const stxAddress = account.address;
      const { signature, message, timestamp } = signClaimMessage(
        bountyId,
        stxAddress,
        account.privateKey
      );

      const res = await fetch(`${BOUNTY_API}/bounties/${bountyId}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claimer: stxAddress,
          signature,
          message,
          timestamp,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        printJson({
          success: false,
          error: (data as Record<string, unknown>).error ?? `HTTP ${res.status}`,
          bountyId,
        });
        return;
      }

      printJson({
        success: true,
        bountyId,
        claimer: stxAddress,
        message: "Bounty claimed. Start building and submit your PR.",
        ...(data as object),
      });
    } catch (err) {
      handleError(err);
    }
  });

// -- status -----------------------------------------------------------------
program
  .command("status")
  .description("Bounty board health — open, claimed, completed counts")
  .action(async () => {
    try {
      const bounties = await fetchBounties();

      const stats = {
        total: bounties.length,
        open: bounties.filter((b) => b.status === "open").length,
        claimed: bounties.filter((b) => b.status === "claimed").length,
        completed: bounties.filter((b) => b.status === "completed").length,
        cancelled: bounties.filter((b) => b.status === "cancelled").length,
        totalRewardsOpen: bounties
          .filter((b) => b.status === "open")
          .reduce((sum, b) => sum + (b.reward ?? 0), 0),
      };

      printJson({
        success: true,
        ...stats,
        summary: `${stats.open} open bounties worth ${stats.totalRewardsOpen.toLocaleString()} sats`,
      });
    } catch (err) {
      handleError(err);
    }
  });

// -- my-bounties ------------------------------------------------------------
program
  .command("my-bounties")
  .description("List bounties you have claimed or posted")
  .option("--address <stx>", "Your STX address")
  .action(async (opts: { address?: string }) => {
    try {
      const stxAddress = getStxAddress(opts.address);
      const bounties = await fetchBounties();

      const mine = bounties.filter(
        (b) => b.claimer === stxAddress || b.poster === stxAddress
      );

      printJson({
        success: true,
        agent: stxAddress,
        claimed: mine.filter((b) => b.claimer === stxAddress).length,
        posted: mine.filter((b) => b.poster === stxAddress).length,
        bounties: mine.map((b) => ({
          id: b.id,
          title: b.title,
          status: b.status,
          reward: b.reward,
          role: b.claimer === stxAddress ? "claimer" : "poster",
        })),
      });
    } catch (err) {
      handleError(err);
    }
  });

program.parse();
