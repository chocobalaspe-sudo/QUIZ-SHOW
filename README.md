# 🎮 Quiz Show — Multiplayer (TV + Celulares)

Jogo de perguntas em tempo real no estilo game show. A **TV** mostra o QR Code e as
perguntas; os **jogadores entram pelo celular** escaneando o QR e usam o telefone como
controle. 519 perguntas incluídas.

## ✨ Como funciona a jogada
- A pergunta e as 4 opções (A, B, C, D) aparecem na TV **e** no celular.
- **O primeiro jogador que clicar numa opção trava a rodada** para os outros.
- Se **acertar**, ganha 1 ponto.
- Se **errar**:
  - Com **2 jogadores** → o ponto vai automaticamente para o oponente.
  - Com **3 ou mais jogadores** → a TV mostra que ele errou e **libera** para os demais responderem (quem errou fica de fora até a próxima).
- O placar aparece na TV e no celular de cada jogador.

---

## ▶️ Como rodar

### 1. Pré-requisito
Instale o **Node.js 18 ou superior**: https://nodejs.org

### 2. Instalar e iniciar
Abra o terminal na pasta do projeto e rode:

```bash
npm install
npm start
```

Vai aparecer algo como:

```
Na rede local (TV / celulares):  http://192.168.0.15:3000
```

### 3. Abrir na TV
No computador ligado à TV (ou espelhando a tela), abra no navegador o endereço
**da rede local** mostrado no terminal (ex.: `http://192.168.0.15:3000`) e clique em
**📺 Sou a TV**. Um código de sala e um QR Code aparecerão.

> Dica: se abrir por `localhost`, o servidor já usa automaticamente o IP da rede local
> no QR Code, então os celulares conseguem entrar mesmo assim.

### 4. Jogadores entram
Cada pessoa **escaneia o QR Code** com a câmera do celular (ou acessa o link e digita
o código de 4 letras), coloca um apelido e pronto.

**Importante:** a TV e os celulares precisam estar na **mesma rede Wi‑Fi**.

### 5. Começar
Quando houver 2+ jogadores, escolha tema, número de perguntas e tempo na TV e clique
em **Começar**.

---

## 🌐 Jogar pela internet (fora do Wi‑Fi local)

Para que qualquer pessoa entre de qualquer lugar, hospede o servidor num serviço gratuito
de Node.js. O código já lê a porta de `process.env.PORT`, então funciona direto em:

- **Render** (render.com) — "New Web Service", build `npm install`, start `npm start`.
- **Railway** (railway.app) — importa o repositório e faz deploy.
- **Glitch / Replit** — cole os arquivos e rode.

Depois é só abrir a URL pública do serviço na TV. O QR Code passa a apontar para essa URL
automaticamente (ele usa o endereço em que a página do host foi aberta).

---

## 🗂️ Estrutura
```
server.js            → servidor (salas, buzzer, pontuação) via Socket.IO
questions.js         → banco com as 519 perguntas
public/index.html    → tela inicial (escolhe TV ou jogador)
public/host.html     → tela da TV (QR, perguntas, placar)
public/player.html   → tela do celular (controle do jogador)
```

## 🔧 Personalizar
- **Adicionar perguntas:** edite `questions.js` (formato: `{c:"Tema", q:"Pergunta", o:["A","B","C","D"], a:índiceCorreto}` — `a` vai de 0 a 3).
- **Trocar tempo/quantidade padrão:** ajuste no menu da TV ou em `server.js` (`settings`).
- **Cores/visual:** estão no `<style>` de `host.html` e `player.html`.

Divirta-se! 🎉
