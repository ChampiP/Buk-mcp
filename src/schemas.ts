import { z } from 'zod/v4';

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const pageNumber = z.number().int().min(1).max(500);
const pageSize = z.number().int().min(1).max(100);
const shortFilter = z.string().trim().min(1).max(256);

export const workforceInputSchema = z.object({
  as_of: isoDateSchema,
  exclude_pending: z.boolean().default(true),
}).strict();

export const employeesSearchInputSchema = z.object({
  status: z.enum(['activo', 'inactivo', 'pendiente']).optional(),
  document_number: shortFilter.optional(),
  code_sheet: shortFilter.optional(),
  company_id: z.string().regex(/^\d+$/).max(20).optional(),
  update_start_date: isoDateSchema.optional(),
  custom_attr_job_name: shortFilter.optional(),
  custom_attr_job_value: shortFilter.optional(),
  email: z.string().trim().min(3).max(254).optional(),
  code_recinto: shortFilter.optional(),
  page: pageNumber.default(1),
  page_size: pageSize.default(25),
  sort: z.literal('id').optional(),
}).strict();

export const employeeContextInputSchema = z.object({
  employee_id: z.string().regex(/^(0|[1-9]\d{0,18})$/),
  include_jobs: z.boolean().default(true),
  include_salary: z.boolean().default(true),
}).strict();

export const metaSchema = z.object({
  source: z.literal('BUK'),
  fetched_at: z.string().datetime(),
  complete: z.boolean(),
  returned_count: z.number().int().nonnegative(),
  total_count: z.number().int().nonnegative().nullable(),
  total_count_semantics: z.string(),
  upstream_calls: z.number().int().nonnegative(),
}).strict();

const projectedDateSchema = z.object({ value: z.string().nullable(), source_field: z.string() }).strict();
const projectedValueSchema = z.object({ value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]), source_field: z.string() }).strict();

const employeeCandidateSchema = z.object({
  id: z.string().nullable(),
  full_name: z.string().nullable(),
  status: z.string().nullable(),
  active_since: projectedDateSchema,
  position: z.object({ id: z.string().nullable(), code: z.string().nullable(), name: z.string().nullable() }).strict(),
}).strict();

export const workforceOutputSchema = z.object({
  data: z.object({
    as_of: isoDateSchema,
    exclude_pending: z.boolean(),
    unit: z.literal('employee_records'),
    count: z.number().int().nonnegative().nullable(),
  }).strict(),
  meta: metaSchema,
  warnings: z.array(z.string()),
}).strict();

export const employeesSearchOutputSchema = z.object({
  data: z.object({ candidates: z.array(employeeCandidateSchema) }).strict(),
  meta: metaSchema.extend({ page: z.number().int().positive(), page_size: z.number().int().positive() }).strict(),
  warnings: z.array(z.string()),
}).strict();

const scheduleSchema = z.object({
  weekly_hours: projectedValueSchema,
  days: projectedValueSchema,
  working_schedule_type: projectedValueSchema,
  periodicity: projectedValueSchema,
  frequency: projectedValueSchema,
  daily_start_time: z.null(),
  daily_end_time: z.null(),
  daily_times_available: z.literal(false),
}).strict();

const jobProjectionSchema = z.object({
  dates: z.object({
    start_date: projectedDateSchema,
    end_date: projectedDateSchema,
    end_of_contract: projectedDateSchema,
  }).strict(),
  role: z.object({ id: z.string().nullable(), code: z.string().nullable(), name: z.string().nullable() }).strict(),
  regular_hours: projectedValueSchema,
}).strict();

const contextEmployeeSchema = z.object({
  id: z.string().nullable(),
  full_name: z.string().nullable(),
  status: z.string().nullable(),
  dates: z.object({
    active_since: projectedDateSchema,
    employee_active_until: projectedDateSchema,
    start_date: projectedDateSchema,
    end_date: projectedDateSchema,
    contract_term: projectedDateSchema,
    current_job_active_until: projectedDateSchema,
    contract_finishing_date_1: projectedDateSchema,
    contract_finishing_date_2: projectedDateSchema,
  }).strict(),
  position: z.object({ id: z.string().nullable(), code: z.string().nullable(), name: z.string().nullable() }).strict(),
  schedule: scheduleSchema,
  salary: z.object({ amount: z.number().nullable(), currency: z.null(), source_field: z.literal('current_job.base_wage'), currency_source_field: z.null() }).strict().nullable(),
}).strict();

const jobMetaSchema = z.object({
  complete: z.boolean(),
  returned_count: z.number().int().nonnegative(),
  total_count: z.number().int().nonnegative().nullable(),
  total_count_semantics: z.string(),
  upstream_calls: z.number().int().nonnegative(),
}).strict();

export const employeeContextOutputSchema = z.object({
  data: z.object({
    employee: contextEmployeeSchema,
    jobs: z.array(jobProjectionSchema),
    salary_included: z.boolean(),
  }).strict(),
  meta: metaSchema,
  jobs_meta: jobMetaSchema,
  warnings: z.array(z.string()),
}).strict();

export type WorkforceInput = z.infer<typeof workforceInputSchema>;
export type EmployeesSearchInput = z.infer<typeof employeesSearchInputSchema>;
export type EmployeeContextInput = z.infer<typeof employeeContextInputSchema>;
export type WorkforceOutput = z.infer<typeof workforceOutputSchema>;
export type EmployeesSearchOutput = z.infer<typeof employeesSearchOutputSchema>;
export type EmployeeContextOutput = z.infer<typeof employeeContextOutputSchema>;
