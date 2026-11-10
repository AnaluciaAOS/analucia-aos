// Fixed texts of the owner sheet (SPEC-0004 §2), in en and es. Values (states, kinds, options) stay English.
export const LOCALES = ['en', 'es'];

export const CATALOG = {
  en: {
    sheets: { howto: 'How to use', asks: 'Asks', orders: 'Orders', states: 'States' },
    howto: [
      'This sheet is generated from the project log. Agents never edit it; it is your single channel.',
      'Asks: pick Your decision in the yellow cells of open rows (drop-down) and add a comment if you want.',
      'Orders: for verified orders, pick close or hold in Your sign-off. Empty cells record nothing.',
      'Save the file, then run in your own terminal: aos ceo import <file>. You will be asked to type CONFIRM.',
    ],
    asks: ['ID', 'Kind', 'Question', 'Recommendation', 'Status', 'Your decision', 'Your comment'],
    orders: ['Order', 'Title', 'Risk', 'State', 'Next action by', 'Commits', 'On GitHub', 'Your sign-off', 'Your comment'],
    statesHeader: ['State', 'Meaning'],
    states: {
      draft: 'Being written by the director.',
      ready: 'Definition of Ready passed: kind, acceptance criteria, budget.',
      queued: 'Admitted, waiting for the executor.',
      active: 'The executor is running it.',
      paused: 'Stopped on purpose, with a reason.',
      blocked: 'Cannot proceed: waits for an ask, an order or a decision.',
      delivered: 'The executor finished with outcome done and attached evidence.',
      verified: 'Automatic verification passed: waiting for your sign-off.',
      closed: 'Signed. Done.',
      rejected: 'Ended without delivery: rejected.',
      superseded: 'Ended without delivery: replaced by another record.',
      cancelled: 'Ended without delivery: cancelled.',
    },
  },
  es: {
    sheets: { howto: 'Cómo usar', asks: 'Preguntas', orders: 'Órdenes', states: 'Estados' },
    howto: [
      'Esta hoja se genera desde el registro del proyecto. Los agentes nunca la editan: es tu único canal.',
      'Preguntas: elige Tu decisión en las celdas amarillas de las filas abiertas (lista) y, si quieres, deja un comentario.',
      'Órdenes: en las órdenes verificadas, elige close o hold en Tu firma. Las celdas vacías no registran nada.',
      'Guarda el archivo y ejecuta en tu propia terminal: aos ceo import <archivo>. Te pedirá escribir CONFIRM.',
    ],
    asks: ['ID', 'Tipo', 'Pregunta', 'Recomendación', 'Estado', 'Tu decisión', 'Tu comentario'],
    orders: ['Orden', 'Título', 'Riesgo', 'Estado', 'Próxima acción de', 'Commits', 'En GitHub', 'Tu firma', 'Tu comentario'],
    statesHeader: ['Estado', 'Significado'],
    states: {
      draft: 'El director la está escribiendo.',
      ready: 'Pasó la definición de listo: tipo, criterios de aceptación, presupuesto.',
      queued: 'Admitida, espera al ejecutor.',
      active: 'El ejecutor la está ejecutando.',
      paused: 'Detenida a propósito, con un motivo.',
      blocked: 'No puede avanzar: espera una pregunta, una orden o una decisión.',
      delivered: 'El ejecutor terminó con resultado done y adjuntó la evidencia.',
      verified: 'La verificación automática pasó: espera tu firma.',
      closed: 'Firmada. Terminada.',
      rejected: 'Terminó sin entrega: rechazada.',
      superseded: 'Terminó sin entrega: reemplazada por otro registro.',
      cancelled: 'Terminó sin entrega: cancelada.',
    },
  },
};
