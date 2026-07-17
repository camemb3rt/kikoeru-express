exports.up = async function(knex) {
  const hasColumn = await knex.schema.hasColumn('t_review', 'favorite');
  if (!hasColumn) {
    await knex.schema.alterTable('t_review', table => {
      table.boolean('favorite').notNullable().defaultTo(false);
    });
  }
};

exports.down = async function(knex) {
  const hasColumn = await knex.schema.hasColumn('t_review', 'favorite');
  if (hasColumn) {
    await knex.schema.alterTable('t_review', table => {
      table.dropColumn('favorite');
    });
  }
};
