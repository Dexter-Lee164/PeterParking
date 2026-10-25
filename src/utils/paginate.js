'use strict';

/** Rows per page on every paginated list. */
const PER_PAGE = 10;

/** Compute page metadata for list views. */
function paginate(total, page, perPage = PER_PAGE) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(parseInt(page, 10) || 1, 1), pages);
  return { total, perPage, pages, page: current, offset: (current - 1) * perPage, hasPrev: current > 1, hasNext: current < pages };
}

module.exports = { paginate, PER_PAGE };
