# MindZapp JSON Storage

Este projeto utiliza ficheiros JSON simples para simular uma base de dados. Cada utilizador tem o seu próprio ficheiro
em `data/users/<userId>.json`. Abaixo está a anatomia de um ficheiro com comentários sobre cada secção.

```jsonc
{
  "id": "g09kEcrULOf6",         // nanoid gerado no registo
  "username": "alice",         // único
  "createdAt": "2025-01-05T13:30:00.000Z",
  "updatedAt": "2025-01-05T13:45:00.000Z",

  "profile": {
    "displayName": "Alice",    // opcional
    "bio": "Estudante de cibersegurança",
    "avatarUrl": "https://...",
    "privacy": "PUBLIC"        // PUBLIC | PRIVATE
  },

  "prefs": {
    "language": "pt-PT",
    "theme": "system",         // light | dark | system
    "notifications": {
      "email": false,
      "push": false
    },
    "solo": {
      "intervals": {            // repetição espaçada manual (segundos)
        "VERY_HARD": 30,
        "HARD": 180,
        "MEDIUM": 3600,
        "EASY": 86400
      }
    }
  },

  "wallet": {
    "balance": 1200,
    "transactions": [
      {
        "id": "txn123",
        "ts": "2025-01-05T13:35:00.000Z",
        "type": "EARN",       // EARN | SPEND
        "amount": 200,
        "reason": "battle_win",
        "ref": "battle_01"
      }
    ]
  },

  "decks": [
    {
      "id": "deck01",
      "title": "Introdução a Hashing",
      "topic": {
        "theme": "IT",
        "subtheme": "Cibersegurança",
        "subsubtheme": "Hashing"
      },
      "visibility": "PUBLIC", // PUBLIC | PRIVATE
      "tags": ["segurança", "hashing"],
      "createdAt": "2025-01-05T13:40:00.000Z",
      "updatedAt": "2025-01-05T13:45:00.000Z",
      "cards": [
        {
          "id": "card01",
          "type": "MCQ_SINGLE",
          "prompt_md": "Qual o objetivo de uma função hash?",
          "data_json": { "correct": [1], "options": ["Integridade", "Compressão"] },
          "time_limit_sec": 30,
          "hint": "Pensa em integridade."
        }
      ]
    }
  ],

  "progress": {
    "card01": {
      "lastAnswerAt": "2025-01-05T13:41:00.000Z",
      "nextReviewAt": "2025-01-05T13:45:00.000Z",
      "lastRating": "MEDIUM",   // VERY_HARD | HARD | MEDIUM | EASY
      "timesAnswered": 5,
      "timesCorrect": 4
    }
  },

  "friends": {
    "accepted": ["userB"],
    "pending": ["userC"]
  },

  "stats": {
    "answersTotal": 123,
    "correctTotal": 100,
    "streakBest": 12
  },

  "auth": {
    "deviceSecrets": ["secret..."],
    "email": "alice@example.com",
    "passwordHash": "$2b$10$...",
    "emailVerified": true,
    "verifyToken": null,
    "verifyTokenExpires": null,
    "resetToken": null,
    "resetTokenExpires": null
  }
}
```

## Escrita atómica

Para evitar ficheiros corrompidos em caso de crash, qualquer escrita passa por `writeJSONAtomic` (`src/lib/store.ts`):
1. escreve o JSON para `user.json.tmp-XXXX`
2. faz `rename` para o ficheiro final.

Isto significa que podes interromper o servidor a meio sem perder dados.

## Convenções

- Sempre que adicionares novos campos ao `UserFile`, garante defaults em `defaultUser()`.
- Usa `saveUser(user)` para persistir mudanças; não escrevas diretamente com `fs.writeFile`.
- IDs usam `nanoid` por defeito.
- Arrays como `wallet.transactions` e `decks` são ordenados pela ordem de inserção (não é imposto sorting).

## Dicas para debugging

- Para listar todos os utilizadores existentes: `ls data/users`.
- Para ver rapidamente o conteúdo: `cat data/users/<id>.json | jq`.
- Se um ficheiro ficar corrompido, o `safeReadUser` ignora-o e regista no log (ativa `LOG_LEVEL=debug`).

Com este esquema podes correr múltiplos servidores (por exemplo, cada dev com o seu ficheiro) e sincronizar
manualmente apenas os utilizadores relevantes.