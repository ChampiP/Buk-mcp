import { McpServer } from '@modelcontextprotocol/server';
import type { BukService } from './service.js';
import type { DomainService } from './domain-service.js';
import { domainDescription } from './domain-descriptions.js';
import { buildDomainInputSchema, domainOutputSchema, domainToolNames } from './domain-tools.js';
import { safeErrorMessage } from './errors.js';
import {
  employeeContextInputSchema,
  employeeContextOutputSchema,
  employeesSearchInputSchema,
  employeesSearchOutputSchema,
  workforceInputSchema,
  workforceOutputSchema,
} from './schemas.js';

const annotations = { readOnlyHint: true, openWorldHint: true } as const;

function successResult(output: object) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

function errorResult(error: unknown) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: safeErrorMessage(error) }],
  };
}

export function createBukMcpServer(service: BukService, domainService?: DomainService): McpServer {
  const server = new McpServer({ name: 'depiloto-buk', version: '1.0.0' });

  server.registerTool('buk_workforce_summary', {
    title: 'Resumen de trabajadores BUK',
    description: 'Cuenta fichas vigentes en una fecha explícita. Recorre y deduplica páginas por id; el conteo no es de personas únicas. Solo lectura.',
    inputSchema: workforceInputSchema,
    outputSchema: workforceOutputSchema,
    annotations,
  }, async (args, context) => {
    try {
      return successResult(await service.workforceSummary(args, { signal: context.mcpReq.signal }));
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('buk_employees_search', {
    title: 'Buscar candidatos de empleados BUK',
    description: 'Usa únicamente filtros publicados por BUK; devuelve candidatos y no elige una persona automáticamente. No acepta búsqueda por nombre.',
    inputSchema: employeesSearchInputSchema,
    outputSchema: employeesSearchOutputSchema,
    annotations,
  }, async (args, context) => {
    try {
      return successResult(await service.employeesSearch(args, { signal: context.mcpReq.signal }));
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('buk_employee_context', {
    title: 'Contexto laboral de empleado BUK',
    description: 'Lee ficha y, opcionalmente, historial de trabajos. Incluye sueldo por defecto; include_salary=false lo omite. El token debe tener permisos de lectura en BUK. BUK no publica horarios diarios de entrada/salida.',
    inputSchema: employeeContextInputSchema,
    outputSchema: employeeContextOutputSchema,
    annotations,
  }, async (args, context) => {
    try {
      return successResult(await service.employeeContext(args, { signal: context.mcpReq.signal }));
    } catch (error) {
      return errorResult(error);
    }
  });

  if (domainService) {
    for (const tool of domainToolNames()) {
      server.registerTool(tool, {
        title: tool.replace(/^buk_/, '').replaceAll('_', ' '),
        description: domainDescription(tool),
        inputSchema: buildDomainInputSchema(tool),
        outputSchema: domainOutputSchema,
        annotations,
      }, async (args, context) => {
        try {
          return successResult(await domainService.query(tool, args, { signal: context.mcpReq.signal }));
        } catch (error) {
          return errorResult(error);
        }
      });
    }
  }

  return server;
}
