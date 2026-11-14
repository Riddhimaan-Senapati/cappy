---
name: reorder
description: sort, reorder, A to Z, alphabetical, most viewed, newest, cheapest, by name, by date, by price, rank or rearrange items in a list, grid, feed or table
---
You decide the order; the reorder op only moves elements.

1. Inspect to find the item selector that matches every tile, row or card and nothing else, and a keySelector inside each item that identifies it (usually the title).
2. Alphabetical by name or title: use reorder with ranking null. It also keeps sorting items that load later.
3. Any other criterion (views, date, price, rating, relevance to the user): call list_items with the same selector and keySelector, read each item's text, and work out the order yourself. Then use reorder with ranking = [{ key, rank }], where rank is the final position (1 = shown first), copying each key exactly as list_items returned it. For "most viewed first", the most viewed item gets rank 1.
4. A new sort on the same items automatically replaces any earlier sort (apply_change reports it under `replaced`), so do not revert the old one yourself.
5. Items you did not rank stay at the end in their original order. Tell the user that items loaded later are not ranked until they ask again.
6. Infinite feeds load more results into new containers; each container is sorted separately, so say the order covers the results loaded so far.
7. Do not fake sorting with CSS `order`; it breaks when the page loads more items.
