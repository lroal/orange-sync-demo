/**
 * @typedef {Object} AddServerTaskArgs
 * @property {string} projectId
 * @property {string} title
 */

/**
 * @param {unknown} rdb
 */
export function createDemoMap(rdb) {
  const orange = /** @type {typeof import('orange-orm')} */ (rdb);
  return orange.map((x) => ({
    team: x.table('team').map(({ column }) => ({
      id: column('id').uuid().primary().notNull(),
      name: column('name').string().notNull()
    })),
    person: x.table('person').map(({ column }) => ({
      id: column('id').uuid().primary().notNull(),
      teamId: column('teamId').uuid().notNull(),
      name: column('name').string().notNull(),
      email: column('email').string()
    })),
    project: x.table('project').map(({ column }) => ({
      id: column('id').uuid().primary().notNull(),
      ownerId: column('ownerId').uuid().notNull(),
      title: column('title').string().notNull(),
      status: column('status').string().notNull(),
      updatedAt: column('updatedAt').dateWithTimeZone()
    })),
    projectDetail: x.table('project_detail').map(({ column }) => ({
      id: column('id').uuid().primary().notNull(),
      projectId: column('projectId').uuid().notNull(),
      summary: column('summary').string(),
      riskLevel: column('riskLevel').string()
    })),
    task: x.table('task').map(({ column }) => ({
      id: column('id').uuid().primary().notNull(),
      projectId: column('projectId').uuid().notNull(),
      assigneeId: column('assigneeId').uuid(),
      title: column('title').string().notNull(),
      done: column('done').boolean(),
      sortOrder: column('sortOrder').numeric()
    }))
  })).map((x) => ({
    team: x.team.map(({ hasMany }) => ({
      people: hasMany(x.person).by('teamId')
    })),
    person: x.person.map(({ references }) => ({
      team: references(x.team).by('teamId').notNull()
    })),
    project: x.project.map(({ references, hasOne, hasMany }) => ({
      owner: references(x.person).by('ownerId').notNull(),
      detail: hasOne(x.projectDetail).by('projectId'),
      tasks: hasMany(x.task).by('projectId')
    })),
    projectDetail: x.projectDetail.map(({ references }) => ({
      project: references(x.project).by('projectId').notNull()
    })),
    task: x.task.map(({ references }) => ({
      project: references(x.project).by('projectId').notNull(),
      assignee: references(x.person).by('assigneeId')
    }))
  }));
}

/** @type {{ project: { updatedAt: { concurrency: 'overwrite' } } }} */
export const demoDbOptions = {
  project: {
    updatedAt: {
      concurrency: 'overwrite'
    }
  }
};

/**
 * Shared command contract. The browser sync client records these commands in
 * the local outbox; the server supplies the real implementation.
 *
 * @type {{
 *   addServerTask(args: AddServerTaskArgs): Promise<void>
 * }}
 */
export const demoCommands = {
  async addServerTask(_args) {}
};
