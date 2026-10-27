const PAGE_SIZE = 25;
const YEAR_START = "2025-01-01";
const YEAR_END = "2025-12-31";

async function completeList(call, tool, request) {
  const payload = await call(tool, {
    request: { ...request, page_size: PAGE_SIZE, all_pages: true },
  });
  if (payload.meta?.complete !== true) {
    throw new Error(`${tool} list traversal did not complete`);
  }
  if (!Array.isArray(payload.data)) {
    throw new Error(`${tool} did not return a list`);
  }
  return payload.data;
}

function assertCompleteSummary(payload, label) {
  if (payload.meta?.complete !== true || typeof payload.data?.count !== "number") {
    throw new Error(`${label} summary is incomplete`);
  }
  return payload.data.count;
}

function inRange(value, start, end) {
  return typeof value === "string" && value >= start && value <= end;
}

function ref(value) {
  if (value == null) return null;
  if (typeof value === "object") return value.id ?? value.code ?? null;
  return value;
}

async function countSearchMatches(call, args, predicate) {
  let page = 1;
  let count = 0;
  for (; page <= 500; page++) {
    const payload = await call("buk_employees_search", {
      ...args,
      page,
      page_size: PAGE_SIZE,
    });
    const candidates = payload.data?.candidates;
    if (!Array.isArray(candidates) || typeof payload.meta?.complete !== "boolean") {
      throw new Error("buk_employees_search returned an invalid page");
    }

    // Aggregate this page immediately; never retain or print employee candidates.
    count += candidates.filter(predicate).length;
    if (payload.meta.complete === true) {
      if (candidates.length >= PAGE_SIZE) {
        throw new Error("buk_employees_search marked a full page complete");
      }
      return count;
    }
    if (candidates.length !== PAGE_SIZE) {
      throw new Error("buk_employees_search stopped before a complete short page");
    }
  }
  throw new Error("buk_employees_search exceeded the page limit without completing");
}

export const recipes = [
  {
    id: "pending-vs-hires-2025",
    question: "¿Cuál es la diferencia entre las altas laborales registradas en 2025 y las fichas pendientes cuyo active_since también cae en 2025? Calcula altas menos fichas pendientes y responde solo con el número.",
    async recipe(call) {
      const pending = await countSearchMatches(
        call,
        { status: "pendiente" },
        (candidate) => inRange(candidate.active_since, YEAR_START, YEAR_END),
      );
      const hires = await completeList(call, "buk_job_events", {
        operation: "jobs_events_hires",
        start_date: YEAR_START,
        end_date: YEAR_END,
      });
      return hires.length - pending;
    },
  },
  {
    id: "workforce-change-2025",
    question: "¿Cuántas fichas vigentes más había al 31 de diciembre de 2025 que al 31 de diciembre de 2024? Usa la dotación reportada para cada fecha y responde solo con la diferencia.",
    async recipe(call) {
      const prior = assertCompleteSummary(
        await call("buk_workforce_summary", { as_of: "2024-12-31" }),
        "2024 year-end workforce",
      );
      const current = assertCompleteSummary(
        await call("buk_workforce_summary", { as_of: "2025-12-31" }),
        "2025 year-end workforce",
      );
      return current - prior;
    },
  },
  {
    id: "holidays-half-year-difference-2025",
    question: "¿Cuántos feriados más registró BUK entre julio y diciembre que entre enero y junio de 2025? Responde solo la diferencia (segundo semestre menos primero).",
    async recipe(call) {
      const firstHalf = await completeList(call, "buk_org_catalogs", {
        operation: "holidays",
        from: YEAR_START,
      });
      const secondHalf = await completeList(call, "buk_org_catalogs", {
        operation: "holidays",
        from: "2025-07-01",
      });
      const firstCount = firstHalf.filter((row) => inRange(row.date, YEAR_START, "2025-06-30")).length;
      const secondCount = secondHalf.filter((row) => inRange(row.date, "2025-07-01", YEAR_END)).length;
      return secondCount - firstCount;
    },
  },
  {
    id: "q1-payroll-workforce-average-2025",
    question: "Para cada período de nómina cerrado entre enero y marzo de 2025, consulta la dotación de fichas vigentes en su fecha de cierre. ¿Cuál fue el promedio de esas dotaciones? Redondea a dos decimales.",
    async recipe(call) {
      const periods = await completeList(call, "buk_payroll_processes", {
        operation: "process_periods",
      });
      const closedQ1 = periods.filter((period) =>
        period.status === "cerrado" &&
        inRange(period.end_date, "2025-01-01", "2025-03-31"),
      );
      if (closedQ1.length === 0) throw new Error("No closed Q1 2025 payroll periods found");
      const counts = [];
      for (const period of closedQ1) {
        counts.push(assertCompleteSummary(
          await call("buk_workforce_summary", { as_of: period.end_date }),
          "payroll-period workforce",
        ));
      }
      const average = counts.reduce((sum, count) => sum + count, 0) / counts.length;
      return average.toFixed(2);
    },
  },
  {
    id: "net-hires-2025",
    question: "Durante 2025, ¿cuál fue el saldo neto de altas menos bajas laborales? Responde solo con el número.",
    async recipe(call) {
      const hires = await completeList(call, "buk_job_events", {
        operation: "jobs_events_hires",
        start_date: YEAR_START,
        end_date: YEAR_END,
      });
      const terminations = await completeList(call, "buk_job_events", {
        operation: "jobs_events_terminations",
        start_date: YEAR_START,
        end_date: YEAR_END,
      });
      return hires.length - terminations.length;
    },
  },
  {
    id: "overtime-h2-vs-h1-2025",
    question: "¿Cuántas horas extra más se registraron de julio a diciembre que de enero a junio de 2025? Responde solo la diferencia en horas con dos decimales.",
    async recipe(call) {
      let firstHalf = 0;
      let secondHalf = 0;
      for (let month = 1; month <= 12; month++) {
        const from = `2025-${String(month).padStart(2, "0")}-01`;
        const to = new Date(Date.UTC(2025, month, 0)).toISOString().slice(0, 10);
        const records = await completeList(call, "buk_attendance", {
          operation: "attendances_overtime",
          from,
          to,
        });
        const hours = records.reduce((sum, record) => sum + Number(record.hours ?? 0), 0);
        if (month <= 6) firstHalf += hours;
        else secondHalf += hours;
      }
      return (secondHalf - firstHalf).toFixed(2);
    },
  },
  {
    id: "approved-vacation-ledger-overlap-2025",
    question: "¿Cuántas solicitudes de vacaciones aprobadas que se superponen con 2025 también aparecen en el registro de vacaciones concedidas? Responde solo con la cantidad.",
    async recipe(call) {
      const requests = await completeList(call, "buk_vacations", {
        operation: "vacations_requested",
        start_before: "2026-01-01",
        end_after: "2024-12-31",
        status: "approved",
      });
      const ledger = await completeList(call, "buk_vacations", {
        operation: "vacations",
        start_before: "2026-01-01",
        end_after: "2024-12-31",
      });
      const ledgerIds = new Set(ledger.map((vacation) => String(vacation.id)));
      return requests.filter((request) =>
        request.status === "approved" &&
        inRange(request.start_date, "1900-01-01", YEAR_END) &&
        inRange(request.end_date, YEAR_START, "9999-12-31") &&
        ledgerIds.has(String(request.id)),
      ).length;
    },
  },
  {
    id: "paid-absence-type-definitions-created-2025",
    question: "¿Cuántas definiciones de tipos de ausencia o permiso con goce de sueldo fueron creadas durante 2025? Responde solo con la cantidad.",
    async recipe(call) {
      const absenceTypes = await completeList(call, "buk_absences", {
        operation: "absences_absence_types",
      });
      const permissionTypes = await completeList(call, "buk_absences", {
        operation: "absences_permission_types",
      });
      const createdAndPaid = (row) => row.with_pay === true && inRange(
        typeof row.created_at === "string" ? row.created_at.slice(0, 10) : "",
        YEAR_START,
        YEAR_END,
      );
      return absenceTypes.filter(createdAndPaid).length + permissionTypes.filter(createdAndPaid).length;
    },
  },
  {
    id: "hires-in-active-areas-2025",
    question: "¿Cuántas altas laborales registradas durante 2025 quedaron asociadas a un área presente en el catálogo organizacional? Responde solo con la cantidad.",
    async recipe(call) {
      const hires = await completeList(call, "buk_job_events", {
        operation: "jobs_events_hires",
        start_date: YEAR_START,
        end_date: YEAR_END,
      });
      const areas = await completeList(call, "buk_organization", {
        operation: "areas",
        status: "both",
      });
      const areaIds = new Set(areas.map((area) => String(ref(area.id))));
      return hires.filter((hire) => areaIds.has(String(ref(hire.area_id)))).length;
    },
  },
  {
    id: "kpi-definitions-without-measurement-2025",
    question: "¿Cuántas definiciones de KPI de empresa no tuvieron ninguna medición registrada durante 2025? Responde solo con la cantidad.",
    async recipe(call) {
      const definitions = await completeList(call, "buk_company_data", { operation: "kpis" });
      const measurements = await completeList(call, "buk_company_data", { operation: "kpi_data" });
      const measuredIds = new Set();
      if (measurements.length > 0) {
        const idKey = ["kpi_id", "kpiId", "id_kpi"].find((key) => key in measurements[0]);
        const dateKey = ["date", "measurement_date", "period_date", "created_at", "period", "year"].find((key) => key in measurements[0]);
        if (!idKey || !dateKey) throw new Error("KPI measurements lack a recognizable KPI id or date field");
        for (const measurement of measurements) {
          const rawDate = measurement[dateKey];
          const date = typeof rawDate === "number" ? String(rawDate) : String(rawDate ?? "");
          if (date.startsWith("2025") && measurement[idKey] != null) {
            measuredIds.add(String(measurement[idKey]));
          }
        }
      }
      return definitions.filter((definition) => !measuredIds.has(String(definition.id))).length;
    },
  },
];
