# Local brand marks

simple-icons supplies every icon the site renders, except the brands it does
not carry. Amazon's marks were removed from that project at Amazon's request,
so `Amazon` (used by Amazon S3) and `CloudFront` have to be supplied here or
go without — a missing file is not an error, the cell just falls back to a
two-letter chip.

To add one, drop a single-path SVG in this directory named after the `icon`
value in `lib/stack.js`:

    src/icons/Amazon.svg      ->  icon: "Amazon"

Requirements:

- one `<path d="…">` (the first is used, extra paths are ignored with a warning)
- a square `viewBox`, any size — it is read off the root `<svg>`
- optionally `data-hex="RRGGBB"` on the root `<svg>` for the brand colour

Without `data-hex` the mark follows the theme's text colour, which is what the
luminance guard does for very dark or very light brands anyway.

Check the licence of any mark you add. Most companies permit using their logo
to refer to their own product, but that is not universal, and it is the reason
these are not vendored by default.
