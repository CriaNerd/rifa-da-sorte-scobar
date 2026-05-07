const money = cents => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function pass() {
  return document.getElementById("adminPass").value;
}

async function adminFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-admin-password": pass(),
      ...(options.headers || {})
    }
  });
}

async function loadOrders() {
  const box = document.getElementById("orders");
  box.innerHTML = "Carregando...";

  const res = await adminFetch("/api/admin/orders");
  const data = await res.json();

  if (!res.ok) {
    box.innerHTML = `<p>Erro: ${data.error}</p>`;
    return;
  }

  if (!data.length) {
    box.innerHTML = "<p>Nenhum pedido encontrado.</p>";
    return;
  }

  box.innerHTML = data.map(o => `
    <div class="order">
      <h3>#${o.id} - ${o.customerName}</h3>
      <p><strong>Status:</strong> ${o.status} | <strong>MP:</strong> ${o.mpStatus || "-"} | <strong>Total:</strong> ${money(o.amountCents)} | <strong>Qtd:</strong> ${o.quantity}</p>
      <p><strong>WhatsApp:</strong> ${o.phone} | <strong>E-mail:</strong> ${o.email}</p>
      <p><strong>Pagamento:</strong> ${o.mpPaymentId || "-"}</p>
      <p><strong>Números:</strong> ${o.numbers.slice(0, 35).join(", ")}${o.numbers.length > 35 ? "..." : ""}</p>
      <div class="order-actions">
        <button onclick="syncOrder(${o.id})">Consultar status MP</button>
      </div>
    </div>
  `).join("");
}

async function syncOrder(id) {
  const res = await adminFetch(`/api/admin/orders/${id}/sync`, { method: "POST" });
  const data = await res.json();
  alert(data.message || data.error || JSON.stringify(data));
  loadOrders();
}

async function draw() {
  const prize = document.getElementById("prizeName").value || "Prêmio";
  const result = document.getElementById("drawResult");
  result.classList.remove("hidden");
  result.innerHTML = "Sorteando...";

  const res = await adminFetch("/api/admin/draw", {
    method: "POST",
    body: JSON.stringify({ prize })
  });

  const data = await res.json();

  if (!res.ok) {
    result.innerHTML = `<strong>Erro:</strong> ${data.error}`;
    return;
  }

  result.innerHTML = `
    <h3>Resultado do sorteio</h3>
    <p><strong>Prêmio:</strong> ${data.prize}</p>
    <p><strong>Número sorteado:</strong> ${data.winnerNumber}</p>
    <p><strong>Ganhador:</strong> ${data.customerName}</p>
    <p><strong>WhatsApp:</strong> ${data.phone}</p>
    <p><strong>Pedido:</strong> #${data.orderId}</p>
  `;
}

document.getElementById("loadOrders").addEventListener("click", loadOrders);
document.getElementById("drawBtn").addEventListener("click", draw);
