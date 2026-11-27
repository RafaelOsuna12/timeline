/**
 * Red de seguridad de la aplicacion.
 *
 * Sin esto, cualquier excepcion al dibujar una pantalla desmonta el arbol
 * entero de React y el usuario ve una pagina en blanco, sin menu y sin forma
 * de saber que paso ni de volver. Un fallo en una vista no deberia costar el
 * sitio completo.
 *
 * Tiene que ser una clase: los hooks no pueden capturar errores de render.
 */
import { Component } from 'react';
import { Brand } from './Brand.jsx';

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Queda en la consola del navegador para poder diagnosticarlo despues.
    console.error('[pantalla] fallo al dibujar', error, info?.componentStack);
  }

  componentDidUpdate(prevProps) {
    // Al cambiar de ruta se vuelve a intentar: casi siempre el fallo es de
    // una pantalla concreta y el resto del sitio sigue sano.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <Brand height={20} />
        <h1>Algo fallo en esta pantalla</h1>
        <p>
          El resto del sitio sigue funcionando. Vuelve al inicio o recarga la pagina; si se repite,
          avisa indicando en que seccion ocurrio.
        </p>
        <pre className="crash__detail">{String(this.state.error?.message || this.state.error)}</pre>
        <div className="row">
          <button type="button" className="btn btn--primary" onClick={() => window.location.assign('/')}>
            Volver al inicio
          </button>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Recargar
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
