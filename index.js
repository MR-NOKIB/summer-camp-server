const express = require("express");
const cors = require("cors");
const jwt = require('jsonwebtoken');
require('dotenv').config()
const app = express();
const port = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// middleware
app.use(express.json());
app.use(cors({
    origin: 'http://localhost:5173', // Your frontend URL
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    credentials: true
}));

const URL = 'http://localhost:5173';

app.post('/create-checkout-session', async (req, res) => {
    const { price } = req.body;
    
    // Validate price
    if (!price || isNaN(price) || price <= 0) {
        return res.status(400).send({ error: 'Invalid or missing price value' });
    }
    console.log(price);
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            line_items: [
                {
                    price_data: {
                        currency: 'usd',
                        unit_amount: Math.round(price * 100), // Convert to cents
                        product_data: {
                            name: 'Summer Camp Registration',
                        },
                    },
                    quantity: 1,
                },
            ],
            mode: 'payment',
            success_url: 'http://localhost:5173/success',
            cancel_url: 'http://localhost:5173/cancel',
        });
        res.json({ url: session.url });
    } catch (error) {
        console.error(error);
        res.status(500).send({ error: error.message });
    }
});

// mongodb connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.ekr4n.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        const userCollection = client.db("summer-camp").collection("users")
        const classCollection = client.db("summer-camp").collection("classes");
        const instructorCollection = client.db("summer-camp").collection("instructors");
        const cartCollection = client.db("summer-camp").collection("cart");





        // jwt token related apis
        app.post("/jwt", async (req, res) => {
            const user = req.body;
            const token = jwt.sign(user, process.env.ACCESS_TOKEN, { expiresIn: '1h' });
            res.send({ token });
        });



        // middleWares
        const verifyToken = (req, res, next) => {
            if (!req.headers.authorization) {
                return res.status(401).send({ message: 'Unauthorized Access' })
            }
            const token = req.headers.authorization.split(' ')[1];
            jwt.verify(token, process.env.ACCESS_TOKEN, (err, decoded) => {
                if (err) {
                    return res.status(401).send({ message: 'Unauthorized Access' })
                }
                req.decoded = decoded;
                next();
            })
        };

        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded.email;
            const query = { email: email };
            const user = await userCollection.findOne(query);
            const isAdmin = user?.role === 'admin';
            if (!isAdmin) {
                return res.status(403).send({ message: 'forbidden access' })
            }
            next();
        };


        const verifyInstructor = async (req, res, next) => {
            const email = req.decoded.email;
            const query = { email: email };
            const user = await userCollection.findOne(query);
            const isInstructor = user?.role === 'instructor';
            if (!isInstructor) {
                return res.status(403).send({ message: 'forbidden access' })
            }
            next();
        };


        const verifyAdminOrInstructor = async (req, res, next) => {
            const email = req.decoded.email;
            const query = { email: email };
            const user = await userCollection.findOne(query);

            const isAdminOrInstructor = user?.role === 'admin' || user?.role === 'instructor';
            if (!isAdminOrInstructor) {
                return res.status(403).send({ message: 'Forbidden access: Admins or instructors only' });
            }
            next();
        };



        // user related apis
        app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
            const result = await userCollection.find().toArray();
            res.send(result);
        });

        // verify Admin
        app.get("/users/admin/:email", verifyToken, async (req, res) => {
            const email = req.params.email;
            if (email !== req.decoded.email) {
                return res.status(403).send({ message: 'unauthorized access' })
            };
            const query = { email: email };
            const user = await userCollection.findOne(query);
            let admin = false;
            if (user) {
                admin = user?.role === 'admin';
            }
            res.send({ admin })
        });


        app.get("/users/instructor/:email", verifyToken, async (req, res) => {
            const email = req.params.email;
            if (email !== req.decoded.email) {
                res.status(403).send({ message: 'unauthorized access' })
            }

            const query = { email: email };
            const user = await userCollection.findOne(query);
            let instructor = false;
            if (user) {
                instructor = user?.role === 'instructor'
            }
            res.send({ instructor });
        })


        app.post("/users", async (req, res) => {
            const user = req.body;
            const query = { email: user.email }
            const existingUser = await userCollection.findOne(query);
            if (existingUser) {
                return res.send({ message: 'user already exist', insertedId: null })
            }
            const result = await userCollection.insertOne(user);
            res.send(result);
        });


        app.delete("/users/:id", verifyToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await userCollection.deleteOne(query);
            res.send(result);
        });


        app.patch('/users/admin/:id', verifyToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const updatedDoc = {
                $set: {
                    role: 'admin',
                }
            }
            const result = await userCollection.updateOne(filter, updatedDoc);
            res.send(result)
        });


        app.patch('/users/instructor/:id', verifyToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const updatedDoc = {
                $set: {
                    role: 'instructor',
                }
            };
            const result = await userCollection.updateOne(filter, updatedDoc);
            res.send(result)
        })





        // classes --related apis
        // get all classes or filtered by price
        app.get("/classes/:limit?", async (req, res) => {
            let query = {};
            const limit = req.params.limit;
            if (limit) {
                query = { price: { $lt: 250 } }
            }
            else if (req.query.email) {
                query = { email: req.params.emil }
            }
            // const query = req.params.limit ? { price: { $lt: 250 } } : { email: req.query.email };
            const result = await classCollection.find(query).toArray();
            res.send(result);
        });


        app.post("/classes", verifyToken, verifyAdminOrInstructor, async (req, res) => {
            const classDate = req.body;
            const result = await classCollection.insertOne(classDate);
            res.send(result);
        });


        app.delete("/classes/:id", verifyToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await classCollection.deleteOne(query);
            res.send(result);
        });







        // instructors --related apis
        app.get("/instructors", async (req, res) => {
            const result = await instructorCollection.find().toArray();
            res.send(result);
        });






        // cart --related apis
        app.get("/carts", async (req, res) => {
            const email = req.query.email;
            const query = { email: email }
            const result = await cartCollection.find(query).toArray();
            res.send(result);
        })

        app.post("/carts", async (req, res) => {
            const cartClasses = req.body;
            const result = await cartCollection.insertOne(cartClasses);
            res.send(result);
        });

        app.delete('/carts/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await cartCollection.deleteOne(query);
            res.send(result);
        });





        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);


// routes
app.get("/", (req, res) => {
    res.send("Hello World");
});

app.listen(port, () => {
    console.log(`Summer Camp Server is running on port ${port}`);
});

