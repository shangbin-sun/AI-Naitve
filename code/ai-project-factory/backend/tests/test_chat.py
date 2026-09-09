import base64
import io

from PIL import Image
from test_factory import workspace, new, wait_job


def upload(client, identity):
    image = io.BytesIO()
    Image.new("RGB", (16, 16), "red").save(image, format="PNG")
    response = client.post(f"/api/workspaces/{identity}/chat-attachments", json={"name": "流程.png", "data": base64.b64encode(image.getvalue()).decode()})
    assert response.status_code == 201
    return response.json(), image.getvalue()


def test_image_message_history_scope_idempotency(workspace):
    client, runtime = workspace
    identity = new(client)
    other = new(client)
    image, binary = upload(client, identity)
    assert client.get(image["url"]).content == binary
    assert client.get(image["url"].replace(identity, other)).status_code == 404
    body = {"content": "", "attachment_ids": [image["id"]], "request_id": "image", "expected_version": 0}
    assert client.post(f"/api/workspaces/{other}/messages", json=body).status_code == 422
    assert client.get(f"/api/workspaces/{other}").json()["messages"] == []
    first = client.post(f"/api/workspaces/{identity}/messages", json=body)
    assert first.status_code == 202
    assert client.post(f"/api/workspaces/{identity}/messages", json=body).json()["id"] == first.json()["id"]
    history = client.get(f"/api/workspaces/{identity}").json()["messages"]
    assert len(history) == 1 and history[0]["attachments"] == [image]
    assert client.delete(image["url"]).status_code == 409
    runtime.release.set()
    wait_job(client, identity, "completed")


def test_invalid_images_and_empty_message(workspace):
    client, _ = workspace
    identity = new(client)
    url = f"/api/workspaces/{identity}"
    for data in ["bad!", base64.b64encode(b"<svg>not an image</svg>").decode()]:
        assert client.post(url + "/chat-attachments", json={"name": "x.png", "data": data}).status_code == 422
    assert client.post(url + "/messages", json={"content": " ", "request_id": "empty", "expected_version": 0}).status_code == 422
    assert client.post(url + "/messages", json={"attachment_ids": ["x"] * 5, "request_id": "too-many", "expected_version": 0}).status_code == 422
    image, _ = upload(client, identity)
    assert client.delete(image["url"]).status_code == 200
    assert client.get(image["url"]).status_code == 404


def test_images_reach_runtime_with_message_association(workspace):
    client, runtime = workspace
    original = runtime.generate
    observed = []
    async def capture(context, event):
        observed.append(context)
        return await original(context, event)
    runtime.generate = capture
    identity = new(client)
    image, binary = upload(client, identity)
    runtime.release.set()
    client.post(f"/api/workspaces/{identity}/messages", json={"content": "按图调整", "attachment_ids": [image["id"]], "request_id": "vision", "expected_version": 0})
    wait_job(client, identity, "completed")
    assert base64.b64decode(observed[0]["chat_images"][0]["data"]) == binary
    assert observed[0]["conversation"][0]["id"] == observed[0]["chat_images"][0]["message_id"]
