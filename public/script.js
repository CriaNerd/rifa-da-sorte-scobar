let campaign = null;

const money = cents => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const compact = n => Number(n || 0).toLocaleString("pt-BR");

async function loadCampaign() {
  const res = await fetch("/api/campaign");
  campaign = await res.json();

  document.getElementById("unitPrice").textContent = money(campaign.unitPriceCents);
  document.getElementById("totalNumbers").textContent = compact(campaign.totalNumbers || 300000);
  document.getElementById("soldNumbers").textContent = compact(campaign.soldNumbers || 0);
  document.getElementById("quantity").min = campaign.minNumbers || 20;

  updateTotal();

  const percent = Math.min(100, (campaign.paidCents / campaign.goals.bmw) * 100);
  document.getElementById("progressFill").style.width = percent + "%";
  document.getElementById("progressText").textContent = percent.toFixed(1).replace(".", ",") + "%";

  setGoal("goal1", "goal1-card", campaign.paidCents >= campaign.goals.pix500_1, "Liberado", "Em andamento");
  setGoal("goal2", "goal2-card", campaign.paidCents >= campaign.goals.pix500_2, "Liberado", "Em andamento");
  setGoal("goal3", "goal3-card", campaign.paidCents >= campaign.goals.pix500_3, "Liberado", "Em andamento");
  setGoal("goal4", "goal4-card", campaign.paidCents >= campaign.goals.pix1000, "Liberado", "Em andamento");
  setGoal("goal5", "goal5-card", campaign.paidCents >= campaign.goals.bmw, "Liberado", "Aguardando conclusão da ação");
}

function setGoal(textId, cardId, unlocked, okText, waitText) {
  const text = document.getElementById(textId);
  const card = document.getElementById(cardId);
  if (text) text.textContent = unlocked ? okText : waitText;
  if (card) card.classList.toggle("unlocked", unlocked);
}

function updateTotal() {
  if (!campaign) return;
  const qty = Number(document.getElementById("quantity").value || 0);
  document.getElementById("totalPrice").textContent = money(qty * campaign.unitPriceCents);
  document.getElementById("selectedQty").textContent = qty;
}

document.querySelectorAll(".number-actions-top button").forEach(btn => {
  btn.addEventListener("click", () => {
    const add = Number(btn.dataset.qty);
    const input = document.getElementById("quantity");
    input.value = Math.max(campaign?.minNumbers || 20, Number(input.value || 0) + add);
    updateTotal();
  });
});

document.getElementById("quantity").addEventListener("input", updateTotal);

document.getElementById("buyBtn").addEventListener("click", async () => {
  const payload = {
    customerName: document.getElementById("customerName").value,
    phone: document.getElementById("phone").value,
    email: document.getElementById("email").value,
    cpf: document.getElementById("cpf").value,
    customerPassword: document.getElementById("customerPassword").value,
    quantity: Number(document.getElementById("quantity").value)
  };

  const result = document.getElementById("result");
  const btn = document.getElementById("buyBtn");
  result.classList.remove("hidden");
  result.innerHTML = "Gerando Pix seguro...";
  btn.disabled = true;

  try {
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok) {
      result.innerHTML = `<strong>Erro:</strong> ${data.error}${data.details ? `<br><small>${data.details}</small>` : ""}`;
      return;
    }

    result.innerHTML = `
      <h3>Pedido #${data.id} reservado</h3>
      <p><strong>Total:</strong> ${money(data.amountCents)}</p>
      ${data.qrCodeBase64 ? `<img class="qr" src="data:image/jpeg;base64,${data.qrCodeBase64}" alt="QR Code Pix" />` : ""}
      <p><strong>Pix copia e cola:</strong></p>
      <textarea readonly onclick="this.select()">${data.pixCode || ""}</textarea>
      ${data.ticketUrl ? `<a class="pay-link" href="${data.ticketUrl}" target="_blank">Abrir pagamento no Mercado Pago</a>` : ""}
      <p>Guarde sua senha. Com ela você acompanha seus números na Área do Comprador.</p>
      <p><strong>Números reservados:</strong></p>
      <div class="number-list">${data.numbers.slice(0, 200).map(n => `<span>${n}</span>`).join("")}</div>
      ${data.numbers.length > 200 ? `<p>Mostrando os primeiros 200 números.</p>` : ""}
    `;

    loadCampaign();
  } catch (error) {
    result.innerHTML = `<strong>Erro:</strong> falha de conexão.`;
  } finally {
    btn.disabled = false;
  }
});

const buyerModal = document.getElementById("buyerModal");
function openBuyerModal() { buyerModal.classList.remove("hidden"); }
function closeBuyerModal() { buyerModal.classList.add("hidden"); }

document.getElementById("buyerAreaBtn").addEventListener("click", openBuyerModal);
document.getElementById("buyerAreaBtn2").addEventListener("click", openBuyerModal);
document.getElementById("closeBuyerModal").addEventListener("click", closeBuyerModal);
document.getElementById("buyMoreBtn").addEventListener("click", closeBuyerModal);

document.getElementById("buyerLoginBtn").addEventListener("click", async () => {
  const phone = document.getElementById("buyerPhone").value;
  const password = document.getElementById("buyerPassword").value;
  const box = document.getElementById("buyerResult");

  box.innerHTML = "Buscando seus pedidos...";

  try {
    const res = await fetch("/api/customer/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, password })
    });

    const data = await res.json();

    if (!res.ok) {
      box.innerHTML = `<div class="customer-order"><strong>Erro:</strong> ${data.error}</div>`;
      return;
    }

    if (!data.orders.length) {
      box.innerHTML = `<div class="customer-order">Nenhum pedido encontrado ainda.</div>`;
      return;
    }

    box.innerHTML = data.orders.map(order => `
      <div class="customer-order">
        <h3>Pedido #${order.id}</h3>
        <p><strong>Status:</strong> ${statusLabel(order.status, order.mpStatus)}</p>
        <p><strong>Total:</strong> ${money(order.amountCents)} | <strong>Quantidade:</strong> ${order.quantity}</p>
        <p><strong>Números:</strong></p>
        <div class="order-numbers">${order.numbers.slice(0, 180).map(n => `<span>${n}</span>`).join("")}</div>
        ${order.numbers.length > 180 ? `<p>Mostrando os primeiros 180 números.</p>` : ""}
      </div>
    `).join("");
  } catch (err) {
    box.innerHTML = `<div class="customer-order"><strong>Erro:</strong> falha de conexão.</div>`;
  }
});

function statusLabel(status, mpStatus) {
  if (status === "paid") return "Pago e confirmado";
  if (status === "reserved") return "Reservado aguardando pagamento";
  if (status === "expired") return "Reserva expirada";
  if (status === "payment_error") return "Erro ao gerar pagamento";
  if (mpStatus) return `${status} / ${mpStatus}`;
  return status;
}

loadCampaign();
