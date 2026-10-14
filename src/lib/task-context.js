const object = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};

/** Prefer explicit host fields; newer Paperclip hosts nest assignments in paperclipWake. */
export function taskContext(raw = {}) {
  const context = object(raw);
  const wake = object(context.paperclipWake);
  const issue = object(wake.issue);
  const ancestors = Array.isArray(wake.ancestors) ? wake.ancestors : [];
  const parent = object(ancestors.find(a => a?.id === issue.parentId) ?? ancestors[0]);
  return {
    ...context,
    taskId: context.taskId ?? context.issueId ?? issue.id,
    taskTitle: context.taskTitle ?? issue.title,
    identifier: context.identifier ?? context.taskIdentifier ?? issue.identifier,
    taskDescription: context.taskDescription ?? context.description ?? issue.description ?? context.paperclipTaskMarkdownAssignment,
    priority: context.priority ?? issue.priority,
    parentId: context.parentId ?? context.parentIssueId ?? issue.parentId ?? parent.id,
    parentTitle: context.parentTitle ?? context.parentIssueTitle ?? parent.title,
    parentDescription: context.parentDescription ?? parent.description,
    dependencies: context.dependencies ?? wake.unresolvedBlockerSummaries ?? wake.blockedBy ?? issue.blockedBy,
  };
}

export function dependencySummary(value) {
  if (!Array.isArray(value)) return typeof value === 'string' ? value : '';
  return value.slice(0, 32).map(item => typeof item === 'string' ? item :
    item && typeof item === 'object' ? [item.identifier ?? item.id, typeof item.status === 'string' ? `(${item.status})` : null].filter(v => typeof v === 'string').join(' ') : '').filter(Boolean).join(', ');
}
