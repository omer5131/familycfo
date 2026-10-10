# Transaction category exclusions

1. Open Transactions.
2. Select a category under “הסתר קטגוריות”. Repeat to exclude more categories.
3. To restore a category, select the category button. To restore all categories, select “נקה הסתרות”.

When a parent category is excluded, the transaction view must also exclude its child categories. The filter applies to the list, row count, page totals, and category report. The URL stores the selected categories. The filter does not change transaction records or totals on other pages.

For a movement between your own accounts, select both transaction rows. Use “שנה סוג…” to select the transfer type. Transfers must not count as income or expense in financial reports. The manual type remains in effect after imports and automatic classification.

The transactions API accepts `excludeCategories` as comma-separated category IDs. Exclusion takes priority over category inclusion. Uncategorized rows remain visible.
