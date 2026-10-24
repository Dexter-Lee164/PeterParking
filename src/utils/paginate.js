'use strict';

/** Compute page metadata for list views. */
function paginate(total, page, perPage = 15) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(parseInt(page, 10) || 1, 1), pages);
  return { total, perPage, pages, page: current, offset: (current - 1) * perPage, hasPrev: current > 1, hasNext: current < pages };
}

module.exports = { paginate };
