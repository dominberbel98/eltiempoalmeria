// Interfaz común de los módulos de descarga (scripts/fuentes/*.ts).
// Cada módulo exporta `export const actualizar: Fuente` y nunca lanza: captura sus errores
// y devuelve ok=false conservando los datos anteriores.
export type Meta = { updatedAt: string; fallosAemet: string[]; fuentes: Record<string, any> };
export type Ctx = { ahora: Date; dirDatos: string /*ruta absoluta a src/data*/; dirRaiz: string; meta: Meta; forzar: boolean; aemetKey: string | undefined; log: (msg: string) => void; yaPidioOpenMeteo: boolean };
export type ResultadoFuente = { fuente: string; ok: boolean; cambiado: boolean; nota?: string; pesoOpenMeteo?: number; peticionesAemet?: number; metaFuente?: Record<string, any> };
export type Fuente = (ctx: Ctx) => Promise<ResultadoFuente>;
