'use strict';

/**
 * Holds the application's single SQLite connection so services can reach it
 * without every function threading `db` through its arguments.
 */
let current = null;

module.exports = {
  set(db) {
    current = db;
  },
  get() {
    if (!current) throw new Error('Database has not been initialised. Call openDatabase() and context.set(db) first.');
    return current;
  },
  clear() {
    current = null;
  },
};
