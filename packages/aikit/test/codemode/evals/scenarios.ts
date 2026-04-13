import { Type } from "@sinclair/typebox";
import { Agent } from "../../../src/agent/agent";

type LedgerEntry = {
	principalNanos: string;
	rateBps: number;
	days: number;
};

type SalesLedgerEntry = {
	regionCode: string;
	grossCents: string;
	discountBps: number;
	chargebackCents: string;
};

type RegionCatalogEntry = {
	code: string;
	name: string;
};

export interface CodeModeEvalScenario<TExpected extends Record<string, unknown> = Record<string, unknown>> {
	id: string;
	name: string;
	prompt: string;
	tools: Agent.AnyAgentTool[];
	expected: TExpected;
	expectedCodeSnippets?: string[];
	systemInstructions?: string[];
	timeoutMs?: number;
}

function calculateLedgerTotals(entries: LedgerEntry[], feeBps: number) {
	return entries.reduce(
		(acc, entry) => {
			const principal = BigInt(entry.principalNanos);
			const gross = (principal * BigInt(entry.rateBps) * BigInt(entry.days)) / 36500n;
			const fee = (gross * BigInt(feeBps)) / 10000n;

			acc.grossNanos += gross;
			acc.feeNanos += fee;
			acc.netNanos += gross - fee;
			return acc;
		},
		{
			grossNanos: 0n,
			feeNanos: 0n,
			netNanos: 0n,
		},
	);
}

function calculateRegionalSales(entries: SalesLedgerEntry[], regions: RegionCatalogEntry[]) {
	const regionNames = new Map(regions.map((region) => [region.code, region.name]));
	const totals = new Map<string, bigint>();

	for (const entry of entries) {
		const grossCents = BigInt(entry.grossCents);
		const discountCents = (grossCents * BigInt(entry.discountBps)) / 10000n;
		const chargebackCents = BigInt(entry.chargebackCents);
		const netCents = grossCents - discountCents - chargebackCents;
		const current = totals.get(entry.regionCode) ?? 0n;
		totals.set(entry.regionCode, current + netCents);
	}

	let topRegionCode = "";
	let topRegionNetCents = -1n;
	let portfolioNetCents = 0n;

	for (const [regionCode, netCents] of totals.entries()) {
		portfolioNetCents += netCents;
		if (netCents > topRegionNetCents) {
			topRegionCode = regionCode;
			topRegionNetCents = netCents;
		}
	}

	return {
		topRegion: regionNames.get(topRegionCode) ?? topRegionCode,
		topRegionNetCents: topRegionNetCents.toString(),
		portfolioNetCents: portfolioNetCents.toString(),
	};
}

export function createLedgerTotalsEval(): CodeModeEvalScenario<{
	grossNanos: string;
	feeNanos: string;
	netNanos: string;
}> {
	const ledgerEntries: LedgerEntry[] = [
		{
			principalNanos: "987654321012345678",
			rateBps: 735,
			days: 31,
		},
		{
			principalNanos: "123456789009876543",
			rateBps: 512,
			days: 17,
		},
	];
	const feeBps = 145;
	const expected = calculateLedgerTotals(ledgerEntries, feeBps);

	return {
		id: "ledger-totals",
		name: "computes ledger totals with integer accrual math",
		prompt: [
			'Compute ledger totals for account "acct_123".',
			"Inside the sandbox call external_loadLedger and external_resolveFeeModel.",
			"Use BigInt for every nanos value and every intermediate calculation.",
			"Do not use Number for nanos arithmetic and do not round intermediate values.",
			"For each ledger entry, compute grossNanos and feeNanos independently, then sum the entry-level results.",
			"Use this exact integer arithmetic formula and do not change the denominators:",
			"grossNanos = (principalNanos * rateBps * days) / 36500",
			"feeNanos = (grossNanos * feeBps) / 10000",
			"netNanos = grossNanos - feeNanos",
			"Use JavaScript BigInt truncating division semantics exactly as written.",
			"Return grossNanos, feeNanos, and netNanos as decimal strings.",
		].join(" "),
		tools: [
			Agent.defineTool({
				name: "loadLedger",
				label: "Load Ledger",
				description: "Load ledger entries for an account",
				parameters: Type.Object({
					accountId: Type.String(),
				}),
				outputSchema: Type.Object({
					entries: Type.Array(
						Type.Object({
							principalNanos: Type.String(),
							rateBps: Type.Number(),
							days: Type.Number(),
						}),
					),
				}),
				async execute() {
					return {
						status: "completed" as const,
						result: {
							content: [{ type: "text" as const, text: "loaded" }],
							details: { entries: ledgerEntries },
							isError: false as const,
						},
					};
				},
			}),
			Agent.defineTool({
				name: "resolveFeeModel",
				label: "Resolve Fee Model",
				description: "Resolve fee basis points for an account",
				parameters: Type.Object({
					accountId: Type.String(),
				}),
				outputSchema: Type.Object({
					feeBps: Type.Number(),
				}),
				async execute() {
					return {
						status: "completed" as const,
						result: {
							content: [{ type: "text" as const, text: "resolved" }],
							details: { feeBps },
							isError: false as const,
						},
					};
				},
			}),
		],
		expected: {
			grossNanos: expected.grossNanos.toString(),
			feeNanos: expected.feeNanos.toString(),
			netNanos: expected.netNanos.toString(),
		},
		expectedCodeSnippets: ["external_loadLedger", "external_resolveFeeModel"],
		systemInstructions: [
			"Do not do the math mentally.",
			"Keep all nanos arithmetic in BigInt until the final decimal-string conversion.",
		],
		timeoutMs: 60_000,
	};
}

export function createRegionalSalesEval(): CodeModeEvalScenario<{
	topRegion: string;
	topRegionNetCents: string;
	portfolioNetCents: string;
}> {
	const salesLedger: SalesLedgerEntry[] = [
		{
			regionCode: "north",
			grossCents: "9876543212345",
			discountBps: 275,
			chargebackCents: "1234567",
		},
		{
			regionCode: "south",
			grossCents: "12345678987654",
			discountBps: 190,
			chargebackCents: "2222222",
		},
		{
			regionCode: "south",
			grossCents: "5678901234567",
			discountBps: 310,
			chargebackCents: "333333",
		},
		{
			regionCode: "west",
			grossCents: "3456789012345",
			discountBps: 125,
			chargebackCents: "444444",
		},
	];
	const regionCatalog: RegionCatalogEntry[] = [
		{ code: "north", name: "North" },
		{ code: "south", name: "South" },
		{ code: "west", name: "West" },
	];
	const expected = calculateRegionalSales(salesLedger, regionCatalog);

	return {
		id: "regional-sales-rollup",
		name: "computes regional sales rollups with joins and bigint aggregation",
		prompt: [
			'Analyze sales for quarter "2025-Q4".',
			"Inside the sandbox call external_loadSalesLedger and external_loadRegionCatalog.",
			"Treat grossCents, discountCents, chargebackCents, netCents, and all aggregates as integer cents.",
			"Use BigInt for all cent values and intermediate arithmetic.",
			"Use this exact integer arithmetic formula and do not change the denominator:",
			"discountCents = (grossCents * discountBps) / 10000",
			"netCents = grossCents - discountCents - chargebackCents",
			"Aggregate netCents by regionCode, map the winning regionCode to the human region name,",
			"and return topRegion, topRegionNetCents, and portfolioNetCents.",
			"Return topRegionNetCents and portfolioNetCents as raw integer cent strings.",
			"Do not divide by 100, format dollars, or insert decimal points.",
		].join(" "),
		tools: [
			Agent.defineTool({
				name: "loadSalesLedger",
				label: "Load Sales Ledger",
				description: "Load sales ledger entries for a quarter",
				parameters: Type.Object({
					quarter: Type.String(),
				}),
				outputSchema: Type.Object({
					entries: Type.Array(
						Type.Object({
							regionCode: Type.String(),
							grossCents: Type.String(),
							discountBps: Type.Number(),
							chargebackCents: Type.String(),
						}),
					),
				}),
				async execute() {
					return {
						status: "completed" as const,
						result: {
							content: [{ type: "text" as const, text: "loaded" }],
							details: { entries: salesLedger },
							isError: false as const,
						},
					};
				},
			}),
			Agent.defineTool({
				name: "loadRegionCatalog",
				label: "Load Region Catalog",
				description: "Load region names for reporting",
				parameters: Type.Object({}),
				outputSchema: Type.Object({
					regions: Type.Array(
						Type.Object({
							code: Type.String(),
							name: Type.String(),
						}),
					),
				}),
				async execute() {
					return {
						status: "completed" as const,
						result: {
							content: [{ type: "text" as const, text: "loaded" }],
							details: { regions: regionCatalog },
							isError: false as const,
						},
					};
				},
			}),
		],
		expected,
		expectedCodeSnippets: ["external_loadSalesLedger", "external_loadRegionCatalog"],
		systemInstructions: [
			"Do not estimate the answer outside the sandbox.",
			"Keep all cent arithmetic in BigInt until the final decimal-string conversion.",
		],
		timeoutMs: 60_000,
	};
}

export const liveCodeModeEvalScenarios = [createLedgerTotalsEval(), createRegionalSalesEval()];
