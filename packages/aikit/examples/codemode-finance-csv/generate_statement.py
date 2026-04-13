from __future__ import annotations

import argparse
import csv
import random
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path


@dataclass(frozen=True)
class TransactionTemplate:
	category: str
	name: str
	kind: str
	min_amount: float
	max_amount: float


DEBIT_TEMPLATES: tuple[TransactionTemplate, ...] = (
	TransactionTemplate("Food", "Milk", "debit", 40, 180),
	TransactionTemplate("Food", "Cafe Coffee Day", "debit", 120, 540),
	TransactionTemplate("Groceries", "DMart", "debit", 400, 4200),
	TransactionTemplate("Rent", "House Rent", "debit", 12000, 38000),
	TransactionTemplate("Utilities", "Electricity Bill", "debit", 900, 4200),
	TransactionTemplate("Utilities", "Water Bill", "debit", 300, 1200),
	TransactionTemplate("Internet", "JioFiber", "debit", 699, 1999),
	TransactionTemplate("Fuel", "IndianOil", "debit", 800, 4200),
	TransactionTemplate("Transport", "Uber", "debit", 120, 1400),
	TransactionTemplate("Shopping", "Amazon", "debit", 250, 8500),
	TransactionTemplate("Shopping", "Flipkart", "debit", 250, 7200),
	TransactionTemplate("Entertainment", "Netflix", "debit", 149, 999),
	TransactionTemplate("Entertainment", "BookMyShow", "debit", 180, 1500),
	TransactionTemplate("Healthcare", "Apollo Pharmacy", "debit", 150, 3200),
	TransactionTemplate("Insurance", "Health Insurance", "debit", 1200, 9000),
	TransactionTemplate("Dining", "McDonald's", "debit", 180, 1200),
	TransactionTemplate("Travel", "IRCTC", "debit", 450, 6500),
	TransactionTemplate("Fees", "ATM Withdrawal Fee", "debit", 10, 45),
	TransactionTemplate("Transfer", "UPI Transfer", "debit", 100, 12000),
	TransactionTemplate("Cash Withdrawal", "ATM Withdrawal", "debit", 500, 10000),
)

# Credit rows are kept less frequent so the statement looks more like a personal bank account.
CREDIT_TEMPLATES: tuple[TransactionTemplate, ...] = (
	TransactionTemplate("Salary", "Monthly Salary", "credit", 35000, 180000),
	TransactionTemplate("Transfer", "Bank Transfer In", "credit", 500, 25000),
	TransactionTemplate("Refund", "Merchant Refund", "credit", 100, 6000),
	TransactionTemplate("Interest", "Savings Interest", "credit", 20, 900),
	TransactionTemplate("Cash Deposit", "Cash Deposit", "credit", 1000, 25000),
	TransactionTemplate("Bonus", "Performance Bonus", "credit", 5000, 75000),
)


def parse_args() -> argparse.Namespace:
	parser = argparse.ArgumentParser(description="Generate a bank-statement-style CSV with 1000 rows by default.")
	parser.add_argument(
		"--output",
		type=Path,
		default=Path("finance_statement.csv"),
		help="Path for the generated CSV file.",
	)
	parser.add_argument(
		"--rows",
		type=int,
		default=1000,
		help="Number of transaction rows to generate.",
	)
	parser.add_argument(
		"--seed",
		type=int,
		default=None,
		help="Optional random seed for reproducible output.",
	)
	return parser.parse_args()


def random_timestamp(start: datetime, end: datetime) -> datetime:
	total_seconds = int((end - start).total_seconds())
	offset = random.randint(0, total_seconds)
	return start + timedelta(seconds=offset)


def choose_transaction() -> TransactionTemplate:
	if random.random() < 0.84:
		return random.choice(DEBIT_TEMPLATES)
	return random.choice(CREDIT_TEMPLATES)


def format_amount(value: float) -> str:
	return f"{value:.2f}"


def generate_rows(count: int) -> list[list[str | int]]:
	end = datetime.now().replace(microsecond=0)
	start = end - timedelta(days=365)

	rows: list[list[str | int]] = []
	timestamps = sorted(random_timestamp(start, end) for _ in range(count))

	for index, timestamp in enumerate(timestamps, start=1):
		template = choose_transaction()
		amount = round(random.uniform(template.min_amount, template.max_amount), 2)

		if template.kind == "debit":
			debits = format_amount(amount)
			credits = "null"
		else:
			debits = "null"
			credits = format_amount(amount)

		rows.append([index, debits, credits, template.category, template.name, timestamp.isoformat()])

	return rows


def write_csv(path: Path, rows: list[list[str | int]]) -> None:
	path.parent.mkdir(parents=True, exist_ok=True)

	with path.open("w", newline="", encoding="utf-8") as file:
		writer = csv.writer(file)
		writer.writerow(["No", "Debits", "Credits", "Category", "Name", "Date"])
		writer.writerows(rows)


def main() -> None:
	args = parse_args()

	if args.rows <= 0:
		raise SystemExit("--rows must be greater than 0")

	if args.seed is not None:
		random.seed(args.seed)

	rows = generate_rows(args.rows)
	write_csv(args.output, rows)

	print(f"Created {args.output} with {args.rows} rows.")


if __name__ == "__main__":
	main()
